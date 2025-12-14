import express, { Request, Response } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import ffmpeg from 'fluent-ffmpeg';
import { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } from '@google/generative-ai';
import YTDlpWrap from 'yt-dlp-wrap';

dotenv.config();

const app = express();
const port = process.env.PORT || 3001;

// --- Setup for yt-dlp ---
const ytDlpWrap = new YTDlpWrap();
// On first run, this will download the yt-dlp binary into the CWD of the process.
// For Render, this will be the project root. We can specify a path if needed.
YTDlpWrap.getGithubReleases(1, 5).then(releases => {
    const suitableRelease = releases.find(r => r.name.includes('yt-dlp') && !r.name.includes('zip'));
    if (suitableRelease) {
        YTDlpWrap.downloadFromGithub(suitableRelease.browser_download_url)
            .then(() => console.log('yt-dlp binary downloaded successfully.'))
            .catch(e => console.error('Failed to download yt-dlp binary:', e));
    }
});


// --- Gemini AI Setup ---
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
if (!GEMINI_API_KEY) {
  console.warn('WARNING: GEMINI_API_KEY is not set. AI features will be disabled.');
}
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY || 'disabled');
const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
const generationConfig = {
  temperature: 0.5,
  topP: 0.95,
  topK: 64,
  maxOutputTokens: 8192,
  responseMimeType: 'application/json',
};
const safetySettings = [
  { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
  { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
  { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
  { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
];

// --- Middleware ---
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true })); // To parse form data
app.use('/uploads', express.static(path.join(__dirname, '..', 'uploads')));


// --- In-Memory Database ---
interface Clip {
  id: string;
  projectId: string;
  title: string;
  start: number;
  end: number;
  url: string;
}
interface Project {
  id:string;
  userId: string;
  title: string;
  fileName: string;
  status: 'processing' | 'completed' | 'failed';
  clips: Clip[];
  createdAt: Date;
  errorMessage?: string;
}
const projects: Project[] = [];
const users = [{ id: 'mock-user-id', email: 'user@example.com' }];

// --- Multer Setup for video uploads ---
const uploadDir = path.join(__dirname, '..', 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, uniqueSuffix + '-' + file.originalname);
  },
});
const upload = multer({ storage: storage, limits: { fileSize: 1024 * 1024 * 500 } }); // 500MB limit


// --- Simplified Auth Middleware ---
const simpleAuth = (req: Request, res: Response, next: Function) => {
  (req as any).user = users[0];
  next();
};

// --- API Endpoints ---
app.get('/api', (req, res) => res.send('AutoShorts AI backend is running!'));

app.get('/api/projects', simpleAuth, (req, res) => {
  const userId = (req as any).user.id;
  const userProjects = projects.filter(p => p.userId === userId).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  res.status(200).json(userProjects);
});

app.get('/api/projects/:id', simpleAuth, (req, res) => {
  const project = projects.find(p => p.id === req.params.id);
  if (!project) return res.status(404).json({ message: 'Project not found' });
  if (project.userId !== (req as any).user.id) return res.status(403).json({ message: 'Forbidden' });
  res.status(200).json(project);
});

const getVideoDuration = (filePath: string): Promise<number> => new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
        if (err) return reject(new Error(`FFprobe error: ${err.message}`));
        const duration = metadata.format.duration;
        if (duration === undefined) return reject(new Error('Could not determine video duration.'));
        resolve(duration);
    });
});

app.post('/api/projects', simpleAuth, upload.single('videoFile'), async (req, res) => {
  const { title, youtubeUrl } = req.body;
  const videoFile = req.file;

  if (!videoFile && !youtubeUrl) {
    return res.status(400).json({ message: 'No video file or YouTube URL provided.' });
  }

  const userId = (req as any).user.id;
  const projectId = `proj-${Date.now()}`;
  
  let tempVideoPath: string | null = null; // For cleaning up YT downloads

  try {
    let sourcePath: string;
    let originalFileName: string;

    if (videoFile) {
        console.log(`[${projectId}] Processing uploaded file: ${videoFile.originalname}`);
        sourcePath = videoFile.path;
        originalFileName = videoFile.originalname;
    } else {
        console.log(`[${projectId}] Processing YouTube URL: ${youtubeUrl}`);
        if (!/^(https?:\/\/)?(www\.)?(youtube\.com|youtu\.?be)\/.+$/.test(youtubeUrl)) {
            throw new Error('Invalid YouTube URL provided.');
        }
        
        const downloadPath = path.join(uploadDir, `${projectId}.%(ext)s`);
        tempVideoPath = await new Promise<string>((resolve, reject) => {
            let resolvedPath: string;
            const process = ytDlpWrap.exec([
                youtubeUrl,
                '-f', 'best[ext=mp4]', // Get best quality MP4
                '-o', downloadPath,
            ]);
            process.on('progress', (progress) => console.log(`[${projectId}] Downloading: ${progress.percent}%`));
            process.on('yt-dlp-exec-data', (data) => {
                if (data.includes('Destination:')) {
                    resolvedPath = data.split('Destination:')[1].trim();
                }
            });
            process.on('close', (code) => {
                if (code === 0) resolve(resolvedPath);
                else reject(new Error(`yt-dlp exited with code ${code}`));
            });
            process.on('error', err => reject(err));
        });
        sourcePath = tempVideoPath;
        originalFileName = youtubeUrl;
    }

    const newProject: Project = {
      id: projectId,
      userId,
      title: title || originalFileName,
      fileName: path.basename(sourcePath),
      status: 'processing',
      clips: [],
      createdAt: new Date(),
    };
    projects.push(newProject);
    res.status(201).json(newProject);
    
    // --- Async processing ---
    const duration = await getVideoDuration(sourcePath);
    console.log(`[${projectId}] Video duration: ${duration}s`);
    let generatedClips: { title: string; start: number; end: number; }[] = [];

    if (GEMINI_API_KEY) {
      try {
        console.log(`[${projectId}] Calling Gemini API...`);
        const prompt = `You are an expert video editor...`; // Prompt remains the same
        const result = await model.generateContent(prompt);
        const responseText = result.response.text();
        const cleanedResponse = responseText.trim().replace(/^```json/, '').replace(/```$/, '').trim();
        generatedClips = JSON.parse(cleanedResponse);
      } catch (aiError: any) {
        console.error(`[${projectId}] Gemini API failed: ${aiError.message}`);
      }
    }

    if (generatedClips.length === 0) {
      console.log(`[${projectId}] Using fallback clip generation.`);
      const clipCount = 3, minClipDuration = 15;
      for (let i = 0; i < clipCount; i++) {
        const start = Math.random() * (duration - minClipDuration);
        generatedClips.push({ title: `Random Clip ${i + 1}`, start, end: Math.min(start + minClipDuration + Math.random() * 45, duration) });
      }
    }
    
    const finalClips: Clip[] = [];
    for (const clipData of generatedClips) {
      const clipId = `clip-${Date.now()}-${Math.round(Math.random() * 1E4)}`;
      const clipFileName = `${projectId}-${clipId}.mp4`;
      const clipOutputPath = path.join(uploadDir, clipFileName);
      await new Promise<void>((resolve, reject) => {
        ffmpeg(sourcePath)
          .setStartTime(clipData.start)
          .setDuration(clipData.end - clipData.start)
          .outputOptions('-c:v copy', '-c:a copy')
          .output(clipOutputPath)
          .on('end', () => {
            finalClips.push({ id: clipId, projectId, title: clipData.title, start: clipData.start, end: clipData.end, url: `/uploads/${clipFileName}` });
            resolve();
          })
          .on('error', (err) => reject(new Error(`FFMPEG clipping failed: ${err.message}`)))
          .run();
      });
    }

    const projectIndex = projects.findIndex(p => p.id === projectId);
    if (projectIndex !== -1) {
      projects[projectIndex].status = 'completed';
      projects[projectIndex].clips = finalClips;
    }

  } catch (error: any) {
    console.error(`[${projectId}] FAILED processing pipeline:`, error.message);
    const projectIndex = projects.findIndex(p => p.id === projectId);
    if (projectIndex !== -1) {
      projects[projectIndex].status = 'failed';
      projects[projectIndex].errorMessage = error.message;
    }
  } finally {
      if (tempVideoPath && fs.existsSync(tempVideoPath)) {
          fs.unlinkSync(tempVideoPath);
          console.log(`[${projectId}] Cleaned up temporary file: ${tempVideoPath}`);
      }
  }
});

if (process.env.NODE_ENV !== 'test') {
  app.listen(port, () => {
    console.log(`Backend server is running on http://localhost:${port}`);
  });
}

export default app;
