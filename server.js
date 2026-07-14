const express = require('express');
const multer = require('multer');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 8080;

// Set this in Railway's environment variables. n8n must send it back as a header.
const API_KEY = process.env.API_KEY || '';

const JOBS_DIR = path.join(__dirname, 'jobs');
if (!fs.existsSync(JOBS_DIR)) fs.mkdirSync(JOBS_DIR, { recursive: true });

// In-memory job tracking. Fine for a single Railway instance / this use case.
const jobs = {}; // jobId -> { status, progressLog, outputPath, error, createdAt }

const MAX_FILES = 7;

// ---- Auth middleware ----
function checkApiKey(req, res, next) {
  if (!API_KEY) return next(); // no key configured = open (not recommended for prod)
  const provided = req.header('x-api-key');
  if (provided !== API_KEY) {
    return res.status(401).json({ error: 'Invalid or missing x-api-key header' });
  }
  next();
}

// ---- Multer setup: temp storage per job ----
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const jobId = req.jobId;
      const dir = path.join(JOBS_DIR, jobId);
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (req, file, cb) => {
      // Keep original filename — we need it to sort by Part_N_of_M
      cb(null, file.originalname);
    },
  }),
  limits: { fileSize: 200 * 1024 * 1024, files: MAX_FILES }, // 200MB per file safety cap
});

// Assign a jobId before multer runs, so files land in the right folder
function assignJobId(req, res, next) {
  req.jobId = crypto.randomUUID();
  next();
}

// ---- Helper: extract Part_N from filename, fallback to Infinity (sorts last) ----
function extractPartNumber(filename) {
  const match = filename.match(/Part[_\s-]?(\d+)[_\s-]?of/i);
  if (match) return parseInt(match[1], 10);
  return null;
}

// ---- Helper: run ffmpeg and resolve/reject on exit ----
function runFfmpeg(args, jobId) {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', args);
    let stderr = '';
    proc.stderr.on('data', (d) => {
      stderr += d.toString();
      jobs[jobId].log = stderr.slice(-4000); // keep last ~4000 chars for debugging
    });
    proc.on('error', (err) => reject(err));
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited with code ${code}. Last log:\n${stderr.slice(-2000)}`));
    });
  });
}

// ---- POST /render ----
// multipart/form-data, field name: "audio" (repeat for each file, original filenames preserved)
// optional query/body params: width, height, fps
app.post('/render', assignJobId, checkApiKey, upload.array('audio', MAX_FILES), async (req, res) => {
  const jobId = req.jobId;
  const files = req.files || [];

  if (files.length === 0) {
    return res.status(400).json({ error: 'No audio files received. Use field name "audio".' });
  }
  if (files.length > MAX_FILES) {
    return res.status(400).json({ error: `Max ${MAX_FILES} audio files allowed.` });
  }

  // Sort by Part_N_of_M extracted from filename
  const sortable = files.map((f) => ({
    file: f,
    part: extractPartNumber(f.originalname),
  }));

  const anyMissing = sortable.some((s) => s.part === null);
  if (anyMissing) {
    // Fallback: keep upload order, but flag it clearly in the job record
    jobs[jobId] = jobs[jobId] || {};
    jobs[jobId].warning = 'One or more filenames did not match "Part_N_of_M" pattern — used upload order instead.';
  } else {
    sortable.sort((a, b) => a.part - b.part);
  }

  const orderedPaths = sortable.map((s) => s.file.path);

  const width = parseInt(req.body.width) || 1280;
  const height = parseInt(req.body.height) || 720;
  const fps = parseInt(req.body.fps) || 25;

  const outputPath = path.join(JOBS_DIR, jobId, 'final_output.mp4');

  jobs[jobId] = {
    ...jobs[jobId],
    status: 'processing',
    createdAt: Date.now(),
    fileOrder: sortable.map((s) => s.file.originalname),
    outputPath,
  };

  // Respond immediately with jobId; render happens in background
  res.json({ jobId, status: 'processing', order: jobs[jobId].fileOrder, warning: jobs[jobId].warning });

  // ---- Build single-pass ffmpeg command ----
  // Black video is an infinite lavfi source; -shortest trims it to match the
  // concatenated audio length, so we never need to precompute duration.
  const inputArgs = [];
  inputArgs.push('-f', 'lavfi', '-i', `color=c=black:s=${width}x${height}:r=${fps}`);
  orderedPaths.forEach((p) => {
    inputArgs.push('-i', p);
  });

  const audioInputsFilter = orderedPaths.map((_, i) => `[${i + 1}:a]`).join('');
  const filterComplex = `${audioInputsFilter}concat=n=${orderedPaths.length}:v=0:a=1[outa]`;

  const args = [
    ...inputArgs,
    '-filter_complex', filterComplex,
    '-map', '0:v',
    '-map', '[outa]',
    '-c:v', 'libx264',
    '-tune', 'stillimage',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    '-b:a', '192k',
    '-shortest',
    '-movflags', '+faststart',
    '-y',
    outputPath,
  ];

  try {
    await runFfmpeg(args, jobId);
    jobs[jobId].status = 'done';
  } catch (err) {
    jobs[jobId].status = 'error';
    jobs[jobId].error = err.message;
  }
});

// ---- GET /status/:jobId ----
app.get('/status/:jobId', checkApiKey, (req, res) => {
  const job = jobs[req.params.jobId];
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json({
    status: job.status,
    warning: job.warning,
    order: job.fileOrder,
    error: job.error,
  });
});

// ---- GET /download/:jobId ----
app.get('/download/:jobId', checkApiKey, (req, res) => {
  const job = jobs[req.params.jobId];
  if (!job) return res.status(404).json({ error: 'Job not found' });
  if (job.status !== 'done') {
    return res.status(409).json({ error: `Job not ready. Current status: ${job.status}` });
  }
  if (!fs.existsSync(job.outputPath)) {
    return res.status(404).json({ error: 'Output file missing' });
  }
  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Content-Disposition', 'attachment; filename="final_output.mp4"');
  fs.createReadStream(job.outputPath).pipe(res);
});

// ---- Cleanup job folder after successful download (optional, saves disk) ----
app.delete('/jobs/:jobId', checkApiKey, (req, res) => {
  const job = jobs[req.params.jobId];
  if (!job) return res.status(404).json({ error: 'Job not found' });
  const dir = path.join(JOBS_DIR, req.params.jobId);
  fs.rm(dir, { recursive: true, force: true }, (err) => {
    if (err) return res.status(500).json({ error: err.message });
    delete jobs[req.params.jobId];
    res.json({ deleted: true });
  });
});

// ---- Housekeeping: auto-delete jobs older than 2 hours ----
setInterval(() => {
  const cutoff = Date.now() - 2 * 60 * 60 * 1000;
  Object.entries(jobs).forEach(([id, job]) => {
    if (job.createdAt && job.createdAt < cutoff) {
      fs.rm(path.join(JOBS_DIR, id), { recursive: true, force: true }, () => {});
      delete jobs[id];
    }
  });
}, 30 * 60 * 1000);

app.get('/', (req, res) => res.json({ status: 'ok', service: 'audio-blackscreen-render-service' }));

app.listen(PORT, () => {
  console.log(`Render service listening on port ${PORT}`);
});
