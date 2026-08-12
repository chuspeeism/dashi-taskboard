import { spawn } from "node:child_process";
import { Socket } from "node:net";

const [executable, encodedArgs] = process.argv.slice(2);
if (!executable || !encodedArgs) process.exit(2);

const child = spawn(executable, JSON.parse(encodedArgs), {
  env: process.env,
  stdio: "inherit",
});

const control = new Socket({ fd: 3, readable: true, writable: false });
const terminateGroup = () => {
  try {
    process.kill(-process.pid, "SIGKILL");
  } catch {
    process.exit(1);
  }
};
control.once("end", terminateGroup);
control.once("error", terminateGroup);
control.resume();

child.once("error", (error) => {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
});
child.once("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
