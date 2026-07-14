import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import path from "path";
import fs from "fs";
import router from "./routes";
import { logger } from "./lib/logger";

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use("/api", router);

// When running inside the Electron desktop app, FRONTEND_STATIC_DIR is set
// to the built probe-commander public folder. This serves the frontend from
// the same server so no proxy or separate process is needed.
const frontendDir = process.env["FRONTEND_STATIC_DIR"];
if (frontendDir && fs.existsSync(frontendDir)) {
  logger.info({ frontendDir }, "Serving frontend static files");
  app.use(express.static(frontendDir));
  app.get("*", (_req, res) => {
    res.sendFile(path.join(frontendDir, "index.html"));
  });
}

export default app;
