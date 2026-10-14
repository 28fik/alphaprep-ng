import { handle } from "hono/cloudflare-pages";
import { app, type Env } from "../../server/app.ts";

export const onRequest: PagesFunction<Env> = handle(app);
