#!/usr/bin/env node

import { releaseMetadata } from "./release-metadata.mjs";

const [packageVersion, releaseTag] = process.argv.slice(2);
console.log(JSON.stringify(releaseMetadata(packageVersion, releaseTag)));
