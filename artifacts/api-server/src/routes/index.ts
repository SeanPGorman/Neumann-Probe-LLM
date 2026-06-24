import { Router, type IRouter } from "express";
import healthRouter from "./health";
import vngRouter from "./vng/index.js";

const router: IRouter = Router();

router.use(healthRouter);
router.use("/vng", vngRouter);

export default router;
