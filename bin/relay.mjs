#!/usr/bin/env node
import {main} from '../src/cli.mjs';
main().catch(error=>{console.error('Relay: '+String(error.message).replace(/[\x00-\x1f\x7f]/g,' '));process.exitCode=1;});
