/// <reference types="node" />

import { runAuthVerification } from '#auth-verification-cli';

process.exitCode = await runAuthVerification(process.argv.slice(2));
