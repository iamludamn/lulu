import { loadSnapshot } from "../snapshot.js";
import { getContext } from "../context.js";

const snapshot = await loadSnapshot(process.argv[2] ?? "", []);
console.log(`版本 ${snapshot.version}，文件 ${snapshot.files} 个`);
console.log(await getContext(snapshot.fs));
