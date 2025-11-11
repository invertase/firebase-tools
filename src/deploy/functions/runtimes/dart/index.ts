import * as fs from "fs";
import * as path from "path";
import { promisify } from "util";
import { ChildProcess } from "child_process";
import * as spawn from "cross-spawn";

import * as runtimes from "..";
import * as backend from "../../backend";
import * as discovery from "../discovery";
import * as supported from "../supported";
import { logger } from "../../../../logger";
import { FirebaseError } from "../../../../error";
import { Build } from "../../build";

/**
 * Create a runtime delegate for the Dart runtime, if applicable.
 * @param context runtimes.DelegateContext
 * @return Delegate Dart runtime delegate
 */
export async function tryCreateDelegate(
  context: runtimes.DelegateContext,
): Promise<Delegate | undefined> {
  const pubspecYamlPath = path.join(context.sourceDir, "pubspec.yaml");

  if (!(await promisify(fs.exists)(pubspecYamlPath))) {
    logger.debug("Customer code is not Dart code.");
    return;
  }
  const runtime = context.runtime ?? supported.latest("dart");
  if (!supported.isRuntime(runtime)) {
    throw new FirebaseError(`Runtime ${runtime as string} is not a valid Dart runtime`);
  }
  if (!supported.runtimeIsLanguage(runtime, "dart")) {
    throw new FirebaseError(
      `Internal error. Trying to construct a dart runtime delegate for runtime ${runtime}`,
      { exit: 1 },
    );
  }
  return Promise.resolve(new Delegate(context.projectId, context.sourceDir, runtime));
}

export class Delegate implements runtimes.RuntimeDelegate {
  public readonly language = "dart";
  constructor(
    private readonly projectId: string,
    private readonly sourceDir: string,
    public readonly runtime: supported.Runtime & supported.RuntimeOf<"dart">,
  ) {}

  private _bin = "";

  get bin(): string {
    if (this._bin === "") {
      this._bin = "dart";
    }
    return this._bin;
  }

  async validate(): Promise<void> {
    // Basic validation: check that pubspec.yaml exists and is readable
    const pubspecYamlPath = path.join(this.sourceDir, "pubspec.yaml");
    try {
      await fs.promises.access(pubspecYamlPath, fs.constants.R_OK);
      // TODO: could add more validation like checking for firebase_functions dependency
    } catch (err: any) {
      throw new FirebaseError(
        `Failed to read pubspec.yaml at ${pubspecYamlPath}: ${err.message}`,
      );
    }
  }

  async build(): Promise<void> {
    // No-op: build_runner handles building
    return Promise.resolve();
  }

  watch(): Promise<() => Promise<void>> {
    const dartRunProcess = spawn(this.bin, ["run", this.sourceDir], {
      cwd: this.sourceDir,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const buildRunnerProcess = spawn(this.bin, ["run", "build_runner", "watch", "-d"], {
      cwd: this.sourceDir,
      stdio: ["ignore", "pipe", "pipe"],
    });

    // Log output from both processes
    dartRunProcess.stdout?.on("data", (chunk: Buffer) => {
      logger.info(`[dart run] ${chunk.toString("utf8")}`);
    });
    dartRunProcess.stderr?.on("data", (chunk: Buffer) => {
      logger.error(`[dart run] ${chunk.toString("utf8")}`);
    });

    buildRunnerProcess.stdout?.on("data", (chunk: Buffer) => {
      logger.info(`[build_runner] ${chunk.toString("utf8")}`);
    });
    buildRunnerProcess.stderr?.on("data", (chunk: Buffer) => {
      logger.error(`[build_runner] ${chunk.toString("utf8")}`);
    });

    // Return cleanup function
    return Promise.resolve(async () => {
      const killProcess = (proc: ChildProcess) => {
        if (!proc.killed && proc.exitCode === null) {
          proc.kill("SIGTERM");
        }
      };

      // Try graceful shutdown first
      killProcess(dartRunProcess);
      killProcess(buildRunnerProcess);

      // Wait a bit for graceful shutdown
      await new Promise((resolve) => setTimeout(resolve, 2000));

      // Force kill if still running
      if (!dartRunProcess.killed && dartRunProcess.exitCode === null) {
        dartRunProcess.kill("SIGKILL");
      }
      if (!buildRunnerProcess.killed && buildRunnerProcess.exitCode === null) {
        buildRunnerProcess.kill("SIGKILL");
      }

      // Wait for both processes to exit
      await Promise.all([
        new Promise<void>((resolve) => {
          if (dartRunProcess.killed || dartRunProcess.exitCode !== null) {
            resolve();
          } else {
            dartRunProcess.once("exit", () => resolve());
          }
        }),
        new Promise<void>((resolve) => {
          if (buildRunnerProcess.killed || buildRunnerProcess.exitCode !== null) {
            resolve();
          } else {
            buildRunnerProcess.once("exit", () => resolve());
          }
        }),
      ]);
    });
  }

  async discoverBuild(
    _configValues: backend.RuntimeConfigValues,
    _envs: backend.EnvironmentVariables,
  ): Promise<Build> {
    // Use file-based discovery from .dart_tool/firebase/functions.yaml
    const yamlDir = path.join(this.sourceDir, ".dart_tool", "firebase");
    const yamlPath = path.join(yamlDir, "functions.yaml");
    let discovered = await discovery.detectFromYaml(yamlDir, this.projectId, this.runtime);

    if (!discovered) {
      // If the file doesn't exist yet, run build_runner to generate it
      logger.debug("functions.yaml not found, running build_runner to generate it...");
      const buildRunnerProcess = spawn(this.bin, ["run", "build_runner", "build"], {
        cwd: this.sourceDir,
        stdio: ["ignore", "pipe", "pipe"],
      });

      // Log build_runner output
      buildRunnerProcess.stdout?.on("data", (chunk: Buffer) => {
        logger.debug(`[build_runner] ${chunk.toString("utf8")}`);
      });
      buildRunnerProcess.stderr?.on("data", (chunk: Buffer) => {
        logger.debug(`[build_runner] ${chunk.toString("utf8")}`);
      });

      await new Promise<void>((resolve, reject) => {
        buildRunnerProcess.on("exit", (code) => {
          if (code === 0 || code === null) {
            resolve();
          } else {
            reject(
              new FirebaseError(
                `build_runner failed with exit code ${code}. Make sure your Dart project is properly configured.`,
              ),
            );
          }
        });
        buildRunnerProcess.on("error", reject);
      });

      // Try to discover again after build_runner completes
      discovered = await discovery.detectFromYaml(yamlDir, this.projectId, this.runtime);
      if (!discovered) {
        throw new FirebaseError(
          `Could not find functions.yaml at ${yamlPath} after running build_runner. ` +
            `Make sure your Dart project is properly configured with firebase_functions.`,
        );
      }
    }

    return discovered;
  }
}
