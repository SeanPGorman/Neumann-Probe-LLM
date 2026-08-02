import { Router, type IRouter } from "express";
import healthRouter from "./health";
import vngRouter from "./vng/index.js";
import logRouter from "./vng/log.js";
import miningRouter from "./vng/mining.js";

const router: IRouter = Router();

router.use(healthRouter);
router.use("/vng", vngRouter);
router.use("/vng/log", logRouter);
router.use("/vng/log", miningRouter);

export default router;
