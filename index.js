import express from "express";
import fs from "fs";
import 'dotenv/config';
import path from "path";
import { exec, spawn } from "child_process";
import { fileURLToPath } from "url";
import { connectredis } from "./redis/redis.js";

const app = express();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
app.use(express.json());

const WORKER_FIELD = process.env.WORKER_FIELD;
const redis_server = await connectredis();

async function pollForJobs() {
  while (true) {
    try {
      const { element: ques_name } = await redis_server.brPop('job_queue', 0);
      console.log(`Got job: ${ques_name}`);

      const code = await redis_server.hGet(ques_name, 'code');
      const data_testcases = await redis_server.hGet(ques_name, WORKER_FIELD);
      if (!data_testcases) continue;
      const testcases = JSON.parse(data_testcases);

      const codePath = path.join(__dirname, `${ques_name}_${WORKER_FIELD}.cpp`);
      const execPath = path.join(__dirname, `${ques_name}_${WORKER_FIELD}.exe`);

      fs.writeFileSync(codePath, code);

      await new Promise((resolve, reject) => {
        exec(`g++ "${codePath}" -o "${execPath}"`,{
            timeout: 10000 
        }, (err, stdout, stderr) => {
          if (err) {
            console.error("Compilation error:", stderr);
            return reject("Compilation failed");
          }
          resolve();
        });
      });

      const updatedTestcases = await Promise.all(testcases.map(tc => {
        return new Promise((resolve) => {
          let timeoutSec = parseInt(tc.timeout);
          if(timeoutSec>2.5){
            timeoutSec = 2.5
          }
          const maxBufferBytes = parseInt(tc.sizeout) * 1024;

          const run = spawn(execPath, [], {
            stdio: ['pipe', 'pipe', 'pipe']
          });

          let result = '';
          let errorOutput = '';

          run.stdout.on('data', data => result += data.toString());
          run.stderr.on('data', data => errorOutput += data.toString());
          const timeoutMs = timeoutSec * 1000;        
          const timer = setTimeout(() => run.kill('SIGKILL'), timeoutMs);

          run.stdin.write(tc.input.replace(/\r\n/g, '\n').trim() + '\n');
          run.stdin.end();

          run.on('close', (code) => {
            clearTimeout(timer);
            let correct = false;

            if (code === 0) {
              correct = result.trim() === tc.expected_output.trim();
            } else if (code === null) {
              result = `Timeout exceeded (${timeoutMs}ms)`;
            } else {
              result = `Runtime error (exit code ${code})\n${errorOutput}`;
            }

            resolve({ ...tc, result, correct });
          });
        });
      }));

      await redis_server.set(`job:${ques_name}:worker:${WORKER_FIELD}`, JSON.stringify(updatedTestcases));
      await redis_server.hSet(`job:${ques_name}:status`, { [WORKER_FIELD]: 'completed' });

      await redis_server.expire(`job:${ques_name}:worker:${WORKER_FIELD}`, 60);  
      await redis_server.expire(`job:${ques_name}:status`, 60);

      fs.unlinkSync(codePath);
      fs.unlinkSync(execPath);

    } catch (err) {
      console.error('Error while polling job:', err);
    }
  }
}

pollForJobs();

app.get('/',(req,res)=>{
  res.send("ok start to work")
})

const port = process.env.PORT
app.listen(port, () => {
  console.log('worker_0 running at port 5000');
});
