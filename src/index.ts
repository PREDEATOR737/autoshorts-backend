import express, { Request, Response } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import ffmpeg from 'fluent-ffmpeg';
import { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } from '@google/generative-ai';

dotenv.config();

const app = express();
const port = process.env.PORT || 3001;

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
app.use('/uploads', express.static(path.join(__dirname, '..', 'uploads')));


// --- In-Memory Database (as per original GEMINI.md) ---
interface Clip {
  id: string;
  projectId: string;
  title: string;
  start: number;
  end: number;
  url: string;
}
interface Project {
  id: string;
  userId: string;
  title: string;
  fileName: string;
  status: 'processing' | 'completed' | 'failed';
  clips: Clip[];
  createdAt: Date;
  errorMessage?: string;
}
const projects: Project[] = [];
const users = [{ id: 'mock-user-id', email: 'user@example.com' }]; // Mock user for simplified auth

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
  // In a real app, you'd verify a JWT or session here.
  // For this project, we'll use a static mock user.
  (req as any).user = users[0];
  next();
};

// --- API Endpoints ---
app.get('/api', (req: Request, res: Response) => {
  res.send('AutoShorts AI backend is running!');
});

// GET all projects for the user
app.get('/api/projects', simpleAuth, (req: Request, res: Response) => {
  const userId = (req as any).user.id;
  const userProjects = projects.filter(p => p.userId === userId).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  res.status(200).json(userProjects);
});

// GET a single project by ID
app.get('/api/projects/:id', simpleAuth, (req: Request, res: Response) => {
  const userId = (req as any).user.id;
  const { id } = req.params;
  const project = projects.find(p => p.id === id);

  if (!project) {
    return res.status(404).json({ message: 'Project not found' });
  }
  if (project.userId !== userId) {
    return res.status(403).json({ message: 'Forbidden' });
  }
  res.status(200).json(project);
});

// Helper to get video duration
const getVideoDuration = (filePath: string): Promise<number> => {
    return new Promise((resolve, reject) => {
        ffmpeg.ffprobe(filePath, (err, metadata) => {
            if (err) return reject(err);
            const duration = metadata.format.duration;
            if (duration === undefined) {
                return reject(new Error('Could not determine video duration.'));
            }
            resolve(duration);
        });
    });
};

// POST a new project and generate clips
app.post('/api/projects', simpleAuth, upload.single('videoFile'), async (req: Request, res: Response) => {
  if (!req.file) {
    return res.status(400).json({ message: 'No video file uploaded.' });
  }

  const userId = (req as any).user.id;
  const { title } = req.body;
  const file = req.file;

  const projectId = `proj-${Date.now()}`;
  const newProject: Project = {
    id: projectId,
    userId,
    title: title || file.originalname,
    fileName: file.filename,
    status: 'processing',
    clips: [],
    createdAt: new Date(),
  };
  projects.push(newProject);
  console.log(`[${projectId}] Created project and started processing.`);

  // Respond early to the client
  res.status(201).json(newProject);

  // --- Start async processing ---
  try {
    const videoPath = file.path;
    const duration = await getVideoDuration(videoPath);
    console.log(`[${projectId}] Video duration: ${duration}s`);
    let generatedClips: { title: string; start: number; end: number; }[] = [];

    // --- AI Clip Generation ---
    if (GEMINI_API_KEY) {
      try {
        console.log(`[${projectId}] Calling Gemini API for clip suggestions...`);
        const prompt = `You are an expert video editor specializing in creating viral short-form clips.
        Analyze the concept of the following video and suggest 3-5 engaging clips. The video is ${Math.round(duration)} seconds long.
        The video title is "${newProject.title}".
        For each clip, provide a compelling title, a start time, and an end time in seconds.
        The clips should be between 15 and 60 seconds long.
        Focus on parts that are visually interesting, have high energy, or contain a key message.
        
        Respond with ONLY a valid JSON array of objects. Each object must have "title" (string), "start" (number), and "end" (number) properties.
        Example: [{"title": "The Big Reveal", "start": 65, "end": 90}]`;

        const chatSession = model.startChat({ generationConfig, safetySettings, history: [] });
        const result = await chatSession.sendMessage(prompt);
        const responseText = result.response.text();
        
        // Clean the response to ensure it's valid JSON
        const cleanedResponse = responseText.trim().replace(/^```json/, '').replace(/```$/, '').trim();
        generatedClips = JSON.parse(cleanedResponse);
        console.log(`[${projectId}] Gemini API returned ${generatedClips.length} clip suggestions.`);
      } catch (aiError: any) {
        console.error(`[${projectId}] Gemini API failed.`, aiError.message);
        // Fallback is triggered below
      }
    }

    // --- Fallback if AI fails or is disabled ---
    if (generatedClips.length === 0) {
      console.log(`[${projectId}] Using fallback to generate random clips.`);
      const clipCount = 3;
      const minClipDuration = 15;
      for (let i = 0; i < clipCount; i++) {
        const start = Math.random() * (duration - minClipDuration);
        const end = Math.min(start + minClipDuration + (Math.random() * 45), duration);
        generatedClips.push({
          title: `Random Clip ${i + 1}`,
          start: Math.round(start),
          end: Math.round(end),
        });
      }
    }
    
    // --- Clipping Process (using ffmpeg) ---
    const finalClips: Clip[] = [];
    for (const clipData of generatedClips) {
      const clipId = `clip-${Date.now()}-${Math.round(Math.random() * 1E4)}`;
      const clipFileName = `${projectId}-${clipId}.mp4`;
      const clipOutputPath = path.join(uploadDir, clipFileName);

      await new Promise<void>((resolve, reject) => {
        ffmpeg(videoPath)
          .setStartTime(clipData.start)
          .setDuration(clipData.end - clipData.start)
          .outputOptions('-c:v copy', '-c:a copy') // Use stream copy for speed if possible
          .output(clipOutputPath)
          .on('end', () => {
            console.log(`[${projectId}] Successfully created clip: ${clipFileName}`);
            finalClips.push({
              id: clipId,
              projectId,
              title: clipData.title,
              start: clipData.start,
              end: clipData.end,
              url: `/uploads/${clipFileName}`, // URL for the client to access
            });
            resolve();
          })
          .on('error', (err) => {
            console.error(`[${projectId}] Failed to create clip: ${clipData.title}`, err);
            reject(err); // Reject promise but continue loop
          })
          .run();
      });
    }

    // --- Finalize Project State ---
    const projectIndex = projects.findIndex(p => p.id === projectId);
    if (projectIndex !== -1) {
      projects[projectIndex].status = 'completed';
      projects[projectIndex].clips = finalClips;
      console.log(`[${projectId}] Processing complete. ${finalClips.length} clips generated.`);
    }

  } catch (error: any) {
    console.error(`[${projectId}] FAILED processing pipeline:`, error.message);
    const projectIndex = projects.findIndex(p => p.id === projectId);
    if (projectIndex !== -1) {
      projects[projectIndex].status = 'failed';
      projects[projectIndex].errorMessage = error.message;
    }
  }
});

// --- Server Start ---
if (process.env.NODE_ENV !== 'test') {
  app.listen(port, () => {
    console.log(`Backend server is running on http://localhost:${port}`);
  });
}

export default app; // Export for testing
