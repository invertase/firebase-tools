import { expect } from "chai";
import * as sinon from "sinon";

import { FirebaseError } from "../../../error";
import * as fsutils from "../../../fsutils";
import * as validate from "../../../deploy/functions/validate";
import * as projectPath from "../../../projectPath";
import * as secretManager from "../../../gcp/secretManager";
import * as backend from "../../../deploy/functions/backend";

describe("validate", () => {
  describe("functionsDirectoryExists", () => {
    const sandbox: sinon.SinonSandbox = sinon.createSandbox();
    let resolvePpathStub: sinon.SinonStub;
    let dirExistsStub: sinon.SinonStub;

    beforeEach(() => {
      resolvePpathStub = sandbox.stub(projectPath, "resolveProjectPath");
      dirExistsStub = sandbox.stub(fsutils, "dirExistsSync");
    });

    afterEach(() => {
      sandbox.restore();
    });

    it("should not throw error if functions directory is present", () => {
      resolvePpathStub.returns("some/path/to/project");
      dirExistsStub.returns(true);

      expect(() => {
        validate.functionsDirectoryExists({ cwd: "cwd" }, "sourceDirName");
      }).to.not.throw();
    });

    it("should throw error if the functions directory does not exist", () => {
      resolvePpathStub.returns("some/path/to/project");
      dirExistsStub.returns(false);

      expect(() => {
        validate.functionsDirectoryExists({ cwd: "cwd" }, "sourceDirName");
      }).to.throw(FirebaseError);
    });
  });

  describe("functionNamesAreValid", () => {
    it("should allow properly formatted function names", () => {
      const functions: any[] = [
        {
          id: "my-function-1",
        },
        {
          id: "my-function-2",
        },
      ];
      expect(() => {
        validate.functionIdsAreValid(functions);
      }).to.not.throw();
    });

    it("should throw error on improperly formatted function names", () => {
      const functions = [
        {
          id: "my-function-!@#$%",
          platform: "gcfv1",
        },
        {
          id: "my-function-!@#$!@#",
          platform: "gcfv1",
        },
      ];

      expect(() => {
        validate.functionIdsAreValid(functions);
      }).to.throw(FirebaseError);
    });

    it("should throw error if some function names are improperly formatted", () => {
      const functions = [
        {
          id: "my-function$%#",
          platform: "gcfv1",
        },
        {
          id: "my-function-2",
          platform: "gcfv2",
        },
      ];

      expect(() => {
        validate.functionIdsAreValid(functions);
      }).to.throw(FirebaseError);
    });

    // I think it should throw error here but it doesn't error on empty or even undefined functionNames.
    // TODO(b/131331234): fix this test when validation code path is fixed.
    it.skip("should throw error on empty function names", () => {
      const functions = [{ id: "", platform: "gcfv1" }];

      expect(() => {
        validate.functionIdsAreValid(functions);
      }).to.throw(FirebaseError);
    });

    it("should throw error on capital letters in v2 function names", () => {
      const functions = [{ id: "Hi", platform: "gcfv2" }];
      expect(() => {
        validate.functionIdsAreValid(functions);
      }).to.throw(FirebaseError);
    });

    it("should throw error on underscores in v2 function names", () => {
      const functions = [{ id: "o_O", platform: "gcfv2" }];
      expect(() => {
        validate.functionIdsAreValid(functions);
      }).to.throw(FirebaseError);
    });
  });

  describe("secretsAreValid", () => {
    const project = "project";

    const ENDPOINT_BASE: Omit<backend.Endpoint, "httpsTrigger"> = {
      project,
      platform: "gcfv2",
      id: "id",
      region: "region",
      entryPoint: "entry",
      runtime: "nodejs16",
    };
    const ENDPOINT: backend.Endpoint = {
      ...ENDPOINT_BASE,
      httpsTrigger: {},
    };

    const secret: secretManager.Secret = { projectId: project, name: "MY_SECRET" };

    let secretVersionStub: sinon.SinonStub;

    beforeEach(() => {
      secretVersionStub = sinon.stub(secretManager, "getSecretVersion").rejects("Unexpected call");
    });

    afterEach(() => {
      secretVersionStub.restore();
    });

    it("passes validation with empty backend", () => {
      expect(validate.secretsAreValid(backend.empty())).to.not.be.rejected;
    });

    it("passes validation with no secret env vars", () => {
      const b = backend.of({
        ...ENDPOINT,
        platform: "gcfv2",
      });
      expect(validate.secretsAreValid(b)).to.not.be.rejected;
    });

    it("fails validation given endpoint with secrets targeting unsupported platform", () => {
      const b = backend.of({
        ...ENDPOINT,
        platform: "gcfv2",
        secretEnvironmentVariables: [
          {
            secret: "MY_SECRET",
            key: "MY_SECRET",
            projectId: "project",
          },
        ],
      });

      expect(validate.secretsAreValid(b)).to.be.rejectedWith(FirebaseError);
    });

    it("fails validation given non-existent secret version", () => {
      secretVersionStub.rejects({ reason: "Secret version does not exist" });

      const b = backend.of({
        ...ENDPOINT,
        platform: "gcfv1",
        secretEnvironmentVariables: [
          {
            secret: "MY_SECRET",
            key: "MY_SECRET",
            projectId: "project",
          },
        ],
      });
      expect(validate.secretsAreValid(b)).to.be.rejectedWith(FirebaseError);
    });

    it("fails validation given disabled secret version", () => {
      secretVersionStub.resolves({
        secret,
        version: "1",
        state: "DISABLED",
      });

      const b = backend.of({
        ...ENDPOINT,
        platform: "gcfv1",
        secretEnvironmentVariables: [
          {
            secret: "MY_SECRET",
            key: "MY_SECRET",
            projectId: "project",
          },
        ],
      });
      expect(validate.secretsAreValid(b)).to.be.rejectedWith(FirebaseError, /DISABLED/);
    });

    it("passes validation given valid secret config", () => {
      secretVersionStub.withArgs(project, secret.name, "3").resolves({
        secret,
        version: "3",
        state: "ENABLED",
      });

      const b = backend.of({
        ...ENDPOINT,
        platform: "gcfv1",
        secretEnvironmentVariables: [
          {
            secret: "MY_SECRET",
            key: "MY_SECRET",
            projectId: "project",
            version: "3",
          },
        ],
      });
      expect(validate.secretsAreValid(b)).to.not.be.rejected;
    });

    it("passes validation and resolves latest version given valid secret config", async () => {
      secretVersionStub.withArgs(project, secret.name, "latest").resolves({
        secret,
        version: "2",
        state: "ENABLED",
      });

      const b = backend.of({
        ...ENDPOINT,
        platform: "gcfv1",
        secretEnvironmentVariables: [
          {
            secret: "MY_SECRET",
            key: "MY_SECRET",
            projectId: "project",
          },
        ],
      });

      await validate.secretsAreValid(b);
      expect(backend.allEndpoints(b)[0].secretEnvironmentVariables![0].version).to.equal("2");
    });
  });
});
