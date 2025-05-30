import express from "express";
import fs from "fs";
import path from "path";
import { exec, spawn } from "child_process";
import { fileURLToPath } from "url";
import fetch from 'node-fetch';
import 'dotenv/config';
import { connectredis } from "./redis/redis.js";

const app = express();
app.use(express.json());

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const WORKER_FIELD = process.env.WORKER_FIELD;
const port = process.env.PORT;
const redis_server = await connectredis();

async function compileCode(language, codePath, execPath) {
  if (language === "cpp") {
    return new Promise((resolve, reject) => {
      exec(`g++ "${codePath}" -o "${execPath}"`, { timeout: 10000 }, (err, _, stderr) => {
        if (err) return reject("C++ Compilation Error:\n" + stderr);
        resolve();
      });
    });
  } else if (language === "java") {
    return new Promise((resolve, reject) => {
      exec(`javac "${codePath}"`, { timeout: 10000 }, (err, _, stderr) => {
        if (err) return reject("Java Compilation Error:\n" + stderr);
        resolve();
      });
    });
  }
  return Promise.resolve();
}

function runTestcase(language, execPath, input, expected_output, timeoutSec, ques_name) {
  return new Promise((resolve) => {
    if (timeoutSec > 2.5) timeoutSec = 2.5;
    const timeoutMs = timeoutSec * 1000;

    let run;
    try {
      if (language === "cpp") {
        run = spawn(execPath, [], { stdio: ['pipe', 'pipe', 'pipe'] });
      } else if (language === "java") {
        run = spawn('java', ['Main'], {
          cwd: path.dirname(execPath),
          stdio: ['pipe', 'pipe', 'pipe']
        });
      } else if (language === "python") {
        run = spawn('python3', [execPath], {
          stdio: ['pipe', 'pipe', 'pipe']
        });
      } else {
        return resolve({
          input,
          expected_output,
          result: `Unsupported language: ${language}`,
          correct: false
        });
      }
    } catch (err) {
      return resolve({
        input,
        expected_output,
        result: `Failed to spawn process for ${language}: ${err.message}`,
        correct: false
      });
    }

    if (!run || !run.stdout) {
      return resolve({
        input,
        expected_output,
        result: `Failed to execute process for ${language}`,
        correct: false
      });
    }

    let result = '';
    let errorOutput = '';
    run.stdout.on('data', data => result += data.toString());
    run.stderr.on('data', data => errorOutput += data.toString());

    const timer = setTimeout(() => run.kill('SIGKILL'), timeoutMs);

    run.stdin.write(input.replace(/\r\n/g, '\n').trim() + '\n');
    run.stdin.end();

    run.on('close', (code) => {
      clearTimeout(timer);
      let correct = false;

      if (code === 0) {
        correct = result.trim() === expected_output.trim();
      } else if (code === null) {
        result = `Timeout exceeded (${timeoutMs}ms)`;
      } else {
        result = `Runtime error (exit code ${code})\n${errorOutput}`;
      }

      resolve({ input, expected_output, result, correct, timeout: timeoutSec });
    });
  });
}


 async function processJob(ques_name, code, language, testcases) {
  const extension = language === 'cpp' ? 'cpp' : language === 'java' ? 'java' : 'py';
  const fileName = `${ques_name}_${WORKER_FIELD}.${extension}`;
  const filePath = path.join(__dirname, fileName);
  const execPath = language === 'java'
    ? path.join(__dirname, '.') // Java runs from class directory
    : filePath.replace(/\.\w+$/, language === 'cpp' ? '.exe' : '.py');

  fs.writeFileSync(filePath, code);

  try {
    await compileCode(language, filePath, execPath);

    const results = await Promise.all(testcases.map(tc =>
      runTestcase(language,execPath, tc.input, tc.expected_output, tc.timeout, ques_name)
    ));

    await redis_server.setEx(`job:${ques_name}:worker:${WORKER_FIELD}`, 30, JSON.stringify(results));
    await redis_server.hSet(`job:${ques_name}:status`, { [WORKER_FIELD]: 'completed' });
    await redis_server.expire(`job:${ques_name}:status`, 30);

  } catch (err) {
    console.error("Error during job processing:", err);
    await redis_server.setEx(`job:${ques_name}:worker:${WORKER_FIELD}`, 30, JSON.stringify([{ error: err.toString() }]));
    await redis_server.hSet(`job:${ques_name}:status`, { [WORKER_FIELD]: 'completed' });
  } finally {
    try { fs.unlinkSync(filePath); } catch {}
    try {
      if (language === 'cpp') fs.unlinkSync(execPath);
      if (language === 'java') fs.unlinkSync(filePath.replace('.java', '.class'));
    } catch {}
  }
}

async function pollForJobs() {
  while (true) {
    try {
      const { element: ques_name } = await redis_server.brPop('job_queue', 0);
      console.log(`Got job: ${ques_name}`);

      const code = await redis_server.hGet(ques_name, 'code');
      const language = await redis_server.hGet(ques_name, 'language');
      const data = await redis_server.hGet(ques_name, WORKER_FIELD);
      const data_testcases = await redis_server.hGet(ques_name, WORKER_FIELD);
      if (!data_testcases) continue;
      const testcases = JSON.parse(data_testcases);
      console.log( language, testcases)
      await processJob(ques_name, code, language, testcases);
    } catch (err) {
      console.error("Error while polling job:", err);
    }
  }
}
pollForJobs();

const SELF_URL = process.env.SELF_URL || `http://localhost:${port}/ping`;
setInterval(async () => {
  try {
    const res = await fetch(SELF_URL);
    const text = await res.text();
    console.log(`[✓] Self-ping successful: ${text}`);
  } catch (err) {
    console.error(`[✗] Self-ping failed:`, err.message);
  }
}, 1000 * 60 * 20);

app.get('/ping', (req, res) => {
  console.log('Ping received at', new Date().toISOString());
  res.send('Worker is awake');
});

app.listen(port, () => {
  console.log(`${WORKER_FIELD} running at port ${port}`);
});
