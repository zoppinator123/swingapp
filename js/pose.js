// Pose extraction via MediaPipe Tasks Vision (BlazePose, 33 landmarks).
// Runs fully in-browser; the model is fetched once from Google's CDN.

import {
  FilesetResolver,
  PoseLandmarker,
} from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14";

const WASM_URL =
  "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm";
const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task";

export async function createLandmarker() {
  const fileset = await FilesetResolver.forVisionTasks(WASM_URL);
  return PoseLandmarker.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: MODEL_URL, delegate: "GPU" },
    runningMode: "VIDEO",
    numPoses: 1,
  });
}

function seek(video, t) {
  return new Promise((resolve) => {
    video.addEventListener("seeked", () => resolve(), { once: true });
    video.currentTime = t;
  });
}

// Steps through the video at a fixed sample rate and caches landmarks per
// frame. Returns [{ t, landmarks }] where landmarks is null when no body
// was detected in that frame.
export async function analyzeVideo(video, landmarker, { fps = 30, onProgress } = {}) {
  const frames = [];
  const dt = 1 / fps;
  let ts = 0; // detectForVideo requires a monotonically increasing ms timestamp

  for (let t = 0; t < video.duration; t += dt) {
    await seek(video, t);
    ts += dt * 1000;
    const result = landmarker.detectForVideo(video, ts);
    frames.push({ t: video.currentTime, landmarks: result.landmarks?.[0] ?? null });
    onProgress?.(t / video.duration);
  }

  onProgress?.(1);
  return frames;
}
