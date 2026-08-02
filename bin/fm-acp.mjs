#!/usr/bin/env node
import path from "node:path";
import { launchEntry, packageRootFrom } from "./runtime.mjs";

const root = packageRootFrom(import.meta.url);
const entry = path.join(root, "src", "index.ts");
launchEntry({ entry });
