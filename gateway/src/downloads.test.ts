import test from "node:test";
import assert from "node:assert/strict";
import { getDownloads } from "./downloads.js";

test("public download catalog only exposes verified named GitHub release assets",async()=>{
 const original=globalThis.fetch;
 let calls=0;
 globalThis.fetch=async()=>{
  calls++;
  return new Response(JSON.stringify({
   tag_name:"v1.0.0",html_url:"https://github.com/orhanbal/webrising-commender/releases/tag/v1.0.0",
   draft:false,prerelease:false,
   assets:[
    {name:"WECOMMANDER-windows-x64.exe",browser_download_url:"https://github.com/orhanbal/webrising-commender/releases/download/v1.0.0/WECOMMANDER-windows-x64.exe",size:123456},
    {name:"WECOMMANDER-linux-x64",browser_download_url:"https://github.com/orhanbal/webrising-commender/releases/download/v1.0.0/WECOMMANDER-linux-x64",size:123456},
    {name:"evil-script.exe",browser_download_url:"https://evil.example.com/download.exe",size:3000},
    {name:"WECOMMANDER-macos-universal",browser_download_url:"https://evil.example.com/asset",size:12},
   ]
  }),{status:200,headers:{"content-type":"application/json"}});
 };
 try{
  const data=await getDownloads();
  assert.equal(data.available,true);
  assert.equal(data.tagName,"v1.0.0");
  assert.equal(data.releaseUrl,"https://github.com/orhanbal/webrising-commender/releases/tag/v1.0.0");
  assert.deepEqual(data.assets.map(x=>x.platform),["windows","linux"]);
  assert.ok(data.assets.every(x=>x.url.startsWith("https://github.com/orhanbal/webrising-commender/releases/download/")));
  assert.equal((await getDownloads()).assets.length,2);
  assert.equal(calls,1,"download metadata must be cached");
 }finally{globalThis.fetch=original}
});
