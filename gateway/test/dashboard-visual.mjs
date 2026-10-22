import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const html=readFileSync(new URL("../public/app.html",import.meta.url),"utf8");
const shots=resolve(fileURLToPath(new URL("../test-artifacts",import.meta.url)));
mkdirSync(shots,{recursive:true});
const dates=Array.from({length:7},(_,i)=>{
  const date=new Date(Date.now()-(6-i)*86400000);
  return {day:date.toISOString().slice(0,10),calls:[17,38,43,84,111,95,41][i]};
});
const activity=Array.from({length:6},(_,i)=>({
  tool:["direct.command","direct.file","direct.task","direct.command","direct.system","direct.file"][i],
  outcome:i===4?"error":"success",
  created_at:new Date(Date.now()-(i+1)*600000).toISOString(),
  device_id:null,device_name:["Venture-Windows","Home-Server","Venture-Windows"][i%3]
}));
const mock={
  "/api/public/config":{signupEnabled:true},
  "/api/auth/me":{email:"orhan@example.test",name:"Orhan",role:"viewer",authKind:"session",organizationId:"11111111-1111-4111-8111-111111111111"},
  "/api/auth/organizations":{items:[{id:"11111111-1111-4111-8111-111111111111",name:"WECOMMANDER",role:"viewer"}]},
  "/api/devices":{items:[
    {id:"11111111-1111-4111-8111-111111111101",name:"Venture-Windows",hostname:"venture.local",platform:"windows",online:true,last_seen_at:new Date(Date.now()-120000).toISOString()},
    {id:"11111111-1111-4111-8111-111111111102",name:"Home-Server",hostname:"home.local",platform:"linux",online:true,last_seen_at:new Date(Date.now()-60000).toISOString()},
    {id:"11111111-1111-4111-8111-111111111103",name:"MacBook-Pro",hostname:"macbook.local",platform:"darwin",online:false,last_seen_at:new Date(Date.now()-10800000).toISOString()}
  ]},
  "/api/usage":{monthCalls:142,dailyAverage:7,limit:500,resetAt:new Date(Date.now()+86400000).toISOString(),
    months:Array.from({length:6},(_,i)=>({month:"2026-"+String(i+5).padStart(2,"0"),calls:20+i*21})),
    daily:dates,topTools:[{tool:"direct.command",calls:68},{tool:"direct.file",calls:42},{tool:"mcp.tool",calls:18},{tool:"direct.system",calls:14}]},
  "/api/activity":{items:activity},
  "/api/billing":{mode:"saas",entitled:true,plan:{key:"pro",name:"Pro Plan",metadata:{monthlyPriceTRY:299}},
    subscription:{status:"active",currentPeriodEnd:new Date(Date.now()+86400000*25).toISOString()},
    limits:{maxDevices:null,maxApiTokens:100,maxMembers:5},usage:{devices:3,members:1,pendingInvitations:0,apiTokens:1}}
};
const server=createServer((req,res)=>{
 const pathname=new URL(req.url,"http://localhost").pathname;
 if(pathname==="/app"||pathname==="/app/"){
  res.writeHead(200,{"content-type":"text/html; charset=utf-8","cache-control":"no-store"});res.end(html);return;
 }
 if(pathname==="/health"){res.writeHead(200,{"content-type":"application/json"});res.end(JSON.stringify({ok:true}));return}
 const data=mock[pathname];
 if(data){res.writeHead(200,{"content-type":"application/json","cache-control":"no-store"});res.end(JSON.stringify(data));return}
 res.writeHead(404,{"content-type":"application/json"});res.end(JSON.stringify({error:"not_found"}));
});
await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
const base="http://127.0.0.1:"+server.address().port;
const bins=["google-chrome","google-chrome-stable","chromium","chromium-browser"];
const browser=bins.find(cmd=>spawnSync("which",[cmd],{encoding:"utf8"}).status===0);
if(!browser){server.close();throw Error("Headless Chromium/Chrome not available on CI runner")}
const profile=mkdtempSync(join(tmpdir(),"wc-dashboard-"));
const child=spawn(browser,["--headless=new","--no-sandbox","--disable-dev-shm-usage","--disable-gpu","--no-first-run","--disable-extensions","--disable-background-networking","--disable-default-apps","--disable-features=MediaRouter,OptimizationHints","--remote-debugging-port=0","--remote-allow-origins=*","--user-data-dir="+profile,"about:blank"],{stdio:["ignore","ignore","pipe"]});
let chromeError="";child.stderr.on("data",chunk=>chromeError+=String(chunk).slice(-2500));
let ws;
const pending=new Map(),browserErrors=[];
let nextId=1;
try{
 let port=null;
 for(let i=0;i<600;i++){
  try{port=Number(readFileSync(join(profile,"DevToolsActivePort"),"utf8").split("\n")[0]);if(port)break}catch{}
  if(child.exitCode!==null)throw Error("Chrome exited: "+chromeError);
  await delay(100);
 }
 assert.ok(port,"Chrome DevTools startup timed out after 60s (binary: "+browser+"): "+chromeError);
 let page=null;
 for(let i=0;i<100;i++){
  const list=await (await fetch("http://127.0.0.1:"+port+"/json/list")).json();
  page=list.find(x=>x.type==="page");if(page)break;await delay(100);
 }
 assert.ok(page?.webSocketDebuggerUrl,"Chrome page debugging target missing");
 ws=new WebSocket(page.webSocketDebuggerUrl);
 await new Promise((resolve,reject)=>{ws.addEventListener("open",resolve,{once:true});ws.addEventListener("error",reject,{once:true})});
 ws.addEventListener("message",ev=>{
  const msg=JSON.parse(ev.data);
  if(msg.id&&pending.has(msg.id)){const p=pending.get(msg.id);pending.delete(msg.id);msg.error?p.reject(Error(JSON.stringify(msg.error))):p.resolve(msg.result);return}
  if(msg.method==="Runtime.exceptionThrown")browserErrors.push(msg.params?.exceptionDetails?.text||"Unexpected browser exception");
 });
 const call=(method,params={})=>new Promise((resolve,reject)=>{
  const id=nextId++;pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params}));
 });
 const evalJs=async expression=>{
  const result=await call("Runtime.evaluate",{expression,returnByValue:true,awaitPromise:true});
  if(result.exceptionDetails)throw Error("Browser JavaScript exception: "+JSON.stringify(result.exceptionDetails).slice(0,900));
  return result.result?.value;
 };
 await call("Page.enable");await call("Runtime.enable");
 await call("Emulation.setDeviceMetricsOverride",{width:1536,height:1024,deviceScaleFactor:1,mobile:false});
 await call("Page.navigate",{url:base+"/app"});
 let desktop;
 for(let i=0;i<90;i++){
  await delay(180);
  desktop=await evalJs("(()=>{const box=s=>{const r=document.querySelector(s)?.getBoundingClientRect();return r?{x:r.x,y:r.y,w:r.width,h:r.height}:null};return {active:document.querySelector('#dashboardPage')?.classList.contains('active'),deviceRows:document.querySelectorAll('.wc-device-row').length,activityRows:document.querySelectorAll('.wc-activity-row').length,barCount:document.querySelectorAll('.wc-chart-column').length,operationRows:document.querySelectorAll('.wc-operation-row').length,macIcons:document.querySelectorAll('.wc-os-icon.mac').length,terminalIcons:document.querySelectorAll('.wc-activity-glyph.wc-type-terminal svg').length,planTitle:box('#wcPlanTitle'),sidebar:box('.wc-sidebar'),hero:box('.wc-dash-heading'),stats:[...document.querySelectorAll('.wc-stat')].map(x=>{const r=x.getBoundingClientRect();return {x:r.x,y:r.y,w:r.width}}),main:[box('.wc-devices-panel'),box('.wc-activity-panel')],bottom:[box('.wc-chart-panel'),box('.wc-operations-panel'),box('.wc-plan-panel')],overflow:document.documentElement.scrollWidth-innerWidth}})()");
  if(desktop?.active&&desktop.deviceRows===3&&desktop.barCount===7)break;
 }
 assert.ok(desktop?.active,"Dashboard is not active: "+JSON.stringify(desktop));
 assert.equal(desktop.deviceRows,3,"Device rows did not render");
 assert.equal(desktop.activityRows,6,"Live activity feed did not render");
 assert.equal(desktop.barCount,7,"Seven-day chart did not render");
 assert.equal(desktop.operationRows,5,"Operation breakdown did not render");
 assert.equal(desktop.macIcons,1,"macOS device must have its own icon, not Windows");
 assert.equal(desktop.terminalIcons,2,"Terminal activity SVGs should render without terminal-pane styling");
 assert.ok(desktop.main[0].h<=335,"Device panel is too tall versus reference: "+desktop.main[0].h);
 assert.ok(desktop.bottom[0].y<755,"Bottom panels start too low: "+desktop.bottom[0].y);
 assert.ok(desktop.planTitle.h<34,"Plan heading wrapped unexpectedly");
 assert.equal(desktop.stats.length,4,"Expected four stats");
 assert.ok(desktop.sidebar.w>=285&&desktop.sidebar.w<=310,"Sidebar reference width drift: "+desktop.sidebar.w);
 assert.ok(desktop.stats.every(x=>Math.abs(x.y-desktop.stats[0].y)<2),"Stat cards are not on same row");
 assert.ok(Math.abs(desktop.main[0].y-desktop.main[1].y)<2,"Main panels are not aligned");
 assert.ok(desktop.bottom.every(x=>Math.abs(x.y-desktop.bottom[0].y)<2),"Bottom panels are not aligned");
 assert.ok(desktop.overflow<=2,"Horizontal scrolling detected on desktop: "+desktop.overflow);
 const png=await call("Page.captureScreenshot",{format:"png",captureBeyondViewport:false});
 writeFileSync(join(shots,"dashboard-desktop.png"),Buffer.from(png.data,"base64"));
 await call("Emulation.setDeviceMetricsOverride",{width:390,height:844,deviceScaleFactor:1,mobile:true});
 await call("Page.reload",{ignoreCache:true});
 let mobile;
 for(let i=0;i<80;i++){
  await delay(180);
  mobile=await evalJs("(()=>{const nav=document.querySelector('.wc-sidebar')?.getBoundingClientRect(),menu=document.querySelector('#wcMobileMenu')?.getBoundingClientRect();return {active:document.querySelector('#dashboardPage')?.classList.contains('active'),bars:document.querySelectorAll('.wc-chart-column').length,stats:[...document.querySelectorAll('.wc-stat')].map(x=>x.getBoundingClientRect().y),navLeft:nav?.left,menuVisible:menu?.width>0,overflow:document.documentElement.scrollWidth-innerWidth}})()");
  if(mobile?.active&&mobile.bars===7)break;
 }
 assert.ok(mobile?.menuVisible,"Mobile drawer control is missing");
 assert.ok(mobile?.stats?.[1]>mobile?.stats?.[0],"Mobile metrics must stack");
 assert.ok(mobile?.overflow<=2,"Mobile horizontal overflow: "+JSON.stringify(mobile));
 await evalJs("document.querySelector('#wcMobileMenu').click()");
 await delay(350);
 const opened=await evalJs("({left:document.querySelector('.wc-sidebar').getBoundingClientRect().left,expanded:document.querySelector('#wcMobileMenu').getAttribute('aria-expanded')})");
 assert.equal(opened.expanded,"true","Mobile menu is not interactive");
 assert.ok(opened.left>=-3,"Sidebar is not visible when opened");
 await evalJs("document.querySelector('#wcMobileMenu').click()");
 await delay(350);
 const mobilePng=await call("Page.captureScreenshot",{format:"png",captureBeyondViewport:false});
 writeFileSync(join(shots,"dashboard-mobile.png"),Buffer.from(mobilePng.data,"base64"));
 assert.deepEqual(browserErrors,[],"Uncaught page errors: "+browserErrors.join("; "));
 console.log("PASS: desktop and mobile dashboard browser acceptance",JSON.stringify({desktop,mobile}));
}finally{
 for(const p of pending.values())p.reject(Error("Browser closed"));
 try{ws?.close()}catch{}
 child.kill("SIGTERM");
 server.close();
 try{rmSync(profile,{force:true,recursive:true})}catch{}
}
