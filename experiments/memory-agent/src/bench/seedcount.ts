import { dreamInMemory } from "../snapshot.js";
import { seed, shell } from "../store.js";

const result = await dreamInMemory(`/var/tmp/seedcount-${Date.now()}.db`, async (fs) => {
  const host = shell(fs, []);
  await seed(fs, host);
  return fs.getAllPaths().length;
});
console.log(`种子初始化：内存里共 ${result.result} 个路径，差异提交写入 ${result.changed} 个，提交耗时 ${Math.round(result.commitMs)} 毫秒`);
