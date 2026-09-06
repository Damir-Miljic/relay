import {Store} from '../src/storage.mjs';
import {Discovery} from '../src/discovery.mjs';
const result = await new Discovery(new Store()).snapshot(true);
console.log(JSON.stringify(result, null, 2));
if (result.discovery.error) process.exitCode = 1;
