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

// ---- Helper: extract Part_N from filename, fallback to Infinity (sorts last) ----
function extractPartNumber(filename) {
  const match = filename.match(/Part[_\s-]?(\d+)[_\s-]?of/i);
  if (match) return parseInt(match[1], 10);
  return null;
}

// ---- Helper: run ffmpeg and resolve/reject on exit ----
function runFfmpeg(args, jobId) {
  return new Promise((resolve, reject) => {
    // stdio: explicitly close stdin ('ignore'). Without this, ffmpeg can hang
    // indefinitely waiting on an open-but-unused stdin pipe when spawned
    // headlessly (a well-known child_process + ffmpeg gotcha).
    const proc = spawn('ffmpeg', ['-nostdin', ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';

    const killTimeout = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error('ffmpeg timed out after 10 minutes and was killed. Last log:\n' + stderr.slice(-2000)));
    }, 10 * 60 * 1000);

    proc.stderr.on('data', (d) => {
      stderr += d.toString();
      jobs[jobId].log = stderr.slice(-4000); // keep last ~4000 chars for debugging
    });
    proc.on('error', (err) => {
      clearTimeout(killTimeout);
      reject(err);
    });
    proc.on('close', (code) => {
      clearTimeout(killTimeout);
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited with code ${code}. Last log:\n${stderr.slice(-2000)}`));
    });
  });
}

// ---- POST /job/start ----
// Creates a new job and returns its jobId. Call this once before uploading any files.
app.post('/job/start', checkApiKey, (req, res) => {
  const jobId = crypto.randomUUID();
  const dir = path.join(JOBS_DIR, jobId);
  fs.mkdirSync(dir, { recursive: true });
  jobs[jobId] = {
    status: 'collecting',
    createdAt: Date.now(),
    files: [], // { originalname, path }
  };
  res.json({ jobId });
});

// ---- POST /job/:jobId/upload ----
// Upload ONE audio file at a time. Call this once per file — n8n's HTTP Request
// node already loops automatically over items, so no manual multipart-building
// or Code node buffer work is needed on the n8n side.
// multipart/form-data, single field name: "audio"
const uploadSingle = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const jobId = req.params.jobId;
      const dir = path.join(JOBS_DIR, jobId);
      if (!fs.existsSync(dir)) {
        return cb(new Error('Unknown jobId. Call /job/start first.'));
      }
      cb(null, dir);
    },
    filename: (req, file, cb) => cb(null, file.originalname),
  }),
  limits: { fileSize: 200 * 1024 * 1024 },
});

app.post('/job/:jobId/upload', checkApiKey, (req, res, next) => {
  const jobId = req.params.jobId;
  if (!jobs[jobId]) {
    return res.status(404).json({ error: 'Unknown jobId. Call /job/start first.' });
  }
  next();
}, uploadSingle.single('audio'), (req, res) => {
  const jobId = req.params.jobId;
  if (!req.file) {
    return res.status(400).json({ error: 'No file received. Use field name "audio".' });
  }
  if (jobs[jobId].files.length >= MAX_FILES) {
    return res.status(400).json({ error: `Max ${MAX_FILES} audio files allowed per job.` });
  }
  jobs[jobId].files.push({ originalname: req.file.originalname, path: req.file.path });
  res.json({ jobId, received: req.file.originalname, totalFilesSoFar: jobs[jobId].files.length });
});

// ---- POST /job/:jobId/finish ----
// Call after all files are uploaded. Sorts by Part_N_of_M, renders in the
// background, and returns immediately — poll /status/:jobId for completion.
// optional body params: width, height, fps
app.post('/job/:jobId/finish', checkApiKey, express.urlencoded({ extended: true }), express.json(), (req, res) => {
  const jobId = req.params.jobId;
  const job = jobs[jobId];
  if (!job) {
    return res.status(404).json({ error: 'Unknown jobId.' });
  }
  if (job.files.length === 0) {
    return res.status(400).json({ error: 'No files were uploaded for this job.' });
  }

  const sortable = job.files.map((f) => ({
    file: f,
    part: extractPartNumber(f.originalname),
  }));

  const anyMissing = sortable.some((s) => s.part === null);
  if (anyMissing) {
    job.warning = 'One or more filenames did not match "Part_N_of_M" pattern — used upload order instead.';
  } else {
    sortable.sort((a, b) => a.part - b.part);
  }

  const orderedPaths = sortable.map((s) => s.file.path);

  const width = parseInt(req.body.width) || 640;
  const height = parseInt(req.body.height) || 360;
  const fps = parseInt(req.body.fps) || 1;

  const outputPath = path.join(JOBS_DIR, jobId, 'final_output.mp4');

  job.status = 'processing';
  job.fileOrder = sortable.map((s) => s.file.originalname);
  job.outputPath = outputPath;

  res.json({ jobId, status: 'processing', order: job.fileOrder, warning: job.warning });

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
    '-preset', 'ultrafast',
    '-tune', 'stillimage',
    '-crf', '30',
    '-pix_fmt', 'yuv420p',
    '-r', String(fps),
    '-c:a', 'aac',
    '-b:a', '128k',
    '-shortest',
    '-movflags', '+faststart',
    '-threads', '1',
    '-y',
    outputPath,
  ];

  runFfmpeg(args, jobId)
    .then(() => { job.status = 'done'; })
    .catch((err) => { job.status = 'error'; job.error = err.message; });
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
    log: job.log, // last ~4000 chars of ffmpeg stderr — useful for debugging stuck/slow jobs
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
