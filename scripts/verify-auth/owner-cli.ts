/// <reference types="node" />

// The delivered native CLI owns login and management; this is the checkout driver for that same path.
import { runOwnerCli } from '#auth-owner-cli';

process.exitCode = await runOwnerCli(process.argv.slice(2));
