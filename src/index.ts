import express, { Request, Response } from "express";
import cors from "cors";
import dotenv from "dotenv";
import multer from "multer";
import path from "path";
import fs from "fs";
import ffmpeg from "fluent-ffmpeg";
import { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } from "@google/generative-ai";
import YTDlpWrap from "yt-dlp-wrap";

dotenv.config();

const app = express();
const port = process.env.PORT || 3001;

/* ---------------- yt-dlp (SAFE) ---------------- */
const ytDlpWrap = new YTDlpWrap();

/* ---------------- Gemini AI ---------------- */
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
if (!GEMINI_API_KEY) {
  console.warn("WARNING: GEMINI_API_KEY is not set. AI features disabled.");
}
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY || "disabled");
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

/* ---------------- Middleware ---------------- */
app.use(
  cors({
    origin: [
      "http://localhost:8080",
      "https://silver-nightingale-507266.hostingersite.com",
    ],
    methods: ["GET", "POST"],
  })
);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

/* ---------------- Storage ---------------- */
const uploadDir = path.join(__dirname, "..", "uploads");
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

app.use("/uploads", express.static(uploadDir));

/* ---------------- DB (in-memory) ---------------- */
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
  status: "processing" | "completed" | "failed";
  clips: Clip[];
  createdAt: Date;
  errorMessage?: string;
}
const projects: Project[] = [];
const users = [{ id: "mock-user-id", email: "user@example.com" }];

/* ---------------- Upload ---------------- */
const storage = multer.diskStorage({
  destination: (_, __, cb) => cb(null, uploadDir),
  filename: (_, file, cb) =>
    cb(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}-${file.originalname}`),
});
const upload = multer({
  storage,
  limits: { fileSize: 1024 * 1024 * 500 },
});

/* ---------------- Auth ---------------- */
const simpleAuth = (req: Request, _res: Response, next: Function) => {
  (req as any).user = users[0];
  next();
};

/* ---------------- Utils ---------------- */
const getVideoDuration = (filePath: string): Promise<number> =>
  new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, meta) => {
      if (err) return reject(err);
      if (!meta.format.duration) return reject(new Error("Duration not found"));
      resolve(meta.format.duration);
    });
  });

/* ---------------- Routes ---------------- */
app.get("/api", (_req, res) => res.send("AutoShorts AI backend running"));

app.get("/api/projects", simpleAuth, (req, res) => {
  const uid = (req as any).user.id;
  res.json(
    projects
      .filter((p) => p.userId === uid)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
  );
});

app.get("/api/projects/:id", simpleAuth, (req, res) => {
  const p = projects.find((x) => x.id === req.params.id);
  if (!p) return res.status(404).json({ message: "Not found" });
  res.json(p);
});

/* ---------------- Create Project ---------------- */
app.post(
  "/api/projects",
  simpleAuth,
  upload.single("videoFile"),
  async (req, res) => {
    const { title, youtubeUrl } = req.body;
    const videoFile = req.file;

    if (!videoFile && !youtubeUrl) {
      return res.status(400).json({ message: "No input provided" });
    }

    const projectId = `proj-${Date.now()}`;
    const userId = (req as any).user.id;
    let sourcePath = "";
    let tempVideoPath: string | null = null;

    try {
      /* -------- Source -------- */
      if (videoFile) {
        sourcePath = videoFile.path;
      } else {
        if (!/^(https?:\/\/)?(www\.)?(youtube\.com|youtu\.be)\//.test(youtubeUrl)) {
          throw new Error("Invalid YouTube URL");
        }

        const outputTemplate = path.join(uploadDir, `${projectId}.%(ext)s`);
        const timeoutMs = 120_000;

        tempVideoPath = await new Promise<string>((resolve, reject) => {
          const timeout = setTimeout(
            () => reject(new Error("YouTube download timed out")),
            timeoutMs
          );

          ytDlpWrap
            .exec([
              youtubeUrl,
              "-f",
              "best[ext=mp4]/best",
              "-o",
              outputTemplate,
            ])
            .on("close", (code) => {
              clearTimeout(timeout);
              if (code !== 0) return reject(new Error("yt-dlp failed"));

              const files = fs
                .readdirSync(uploadDir)
                .filter((f) => f.startsWith(projectId + "."));

              if (!files.length) return reject(new Error("No output file"));

              resolve(path.join(uploadDir, files[0]));
            })
            .on("error", (err) => {
              clearTimeout(timeout);
              reject(err);
            });
        });

        sourcePath = tempVideoPath;
      }

      /* -------- Create project -------- */
      const project: Project = {
        id: projectId,
        userId,
        title: title || "Untitled",
        fileName: path.basename(sourcePath),
        status: "processing",
        clips: [],
        createdAt: new Date(),
      };
      projects.push(project);
      res.status(201).json(project);

      /* -------- Processing -------- */
      const duration = await getVideoDuration(sourcePath);

      const clips = [
        { title: "Clip 1", start: 0, end: Math.min(20, duration) },
        { title: "Clip 2", start: 20, end: Math.min(40, duration) },
      ];

      const finalClips: Clip[] = [];

      for (const c of clips) {
        const clipId = `clip-${Date.now()}-${Math.random()}`;
        const outFile = `${projectId}-${clipId}.mp4`;
        const outPath = path.join(uploadDir, outFile);

        await new Promise<void>((resolve, reject) => {
          ffmpeg(sourcePath)
            .setStartTime(c.start)
            .setDuration(c.end - c.start)
            .outputOptions("-preset veryfast")
            .output(outPath)
            .on("end", resolve)
            .on("error", reject)
            .run();
        });

        finalClips.push({
          id: clipId,
          projectId,
          title: c.title,
          start: c.start,
          end: c.end,
          url: `/uploads/${outFile}`,
        });
      }

      project.status = "completed";
      project.clips = finalClips;
    } catch (err: any) {
      const p = projects.find((x) => x.id === projectId);
      if (p) {
        p.status = "failed";
        p.errorMessage = err.message;
      }
    } finally {
      if (tempVideoPath && fs.existsSync(tempVideoPath)) {
        fs.unlinkSync(tempVideoPath);
      }
    }
  }
);

/* ---------------- Start ---------------- */
if (process.env.NODE_ENV !== "test") {
  app.listen(port, () =>
    console.log(`Backend server running on http://localhost:${port}`)
  );
}

export default app;
