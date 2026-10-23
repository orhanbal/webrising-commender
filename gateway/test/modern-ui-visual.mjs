import assert from "node:assert/strict";
import {createServer} from "node:http";
import {readFileSync,existsSync,mkdirSync,writeFileSync,mkdtempSync,rmSync} from "node:fs";
import {spawn,spawnSync} from "node:child_process";
import{tmpdir}from"node:os";
import{join,extname,resolve}from"node:path";
import{setTimeout as sleep}from"node:timers/promises";
const root=resolve(new URL("../ui/dist/",import.meta.url).pathname);
const artifacts=resolve(new URL("../test-artifacts/",import.meta.url).pathname);
mkdirSync(artifacts,{recursive:true});
assert.ok(existsSync(join(root,"index.html")),"Frontend must be built before browser tests");
const fixtures={
 "/api/auth/me":{email:"test@example.com",actor:"test-user",role:"owner",authKind:"session",global:false,organizationId:"aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa"},
 "/api/public/plans":{mode:"saas",paddle:{clientToken:null,checkoutEnabled:false,environment:"sandbox"},plans:[{key:"pro",name:"Pro",description:"Örnek test paketi",featured:true,priceLabel:"$12 / ay",priceId:null,features:["5 cihaz"],maxDevices:5,maxMembers:2,maxApiTokens:4}]},
 "/api/devices":{items:[{id:"11111111-1111-4111-8111-111111111111",name:"Test Windows Device",platform:"windows",online:true,last_seen_at:new Date().toISOString()}]},
 "/api/usage":{monthCalls:42,limit:100,dailyAverage:6,resetAt:"2026-11-01T00:00:00Z",daily:[1,2,3,4,5,6,7].map((n)=>({day:"2026-10-"+String(10+n),calls:n*2})),months:[],topTools:[]},
 "/api/activity":{items:[{tool:"direct.command",outcome:"success",created_at:new Date().toISOString()}]},
 "/api/billing":{mode:"saas",entitled:true,plan:{key:"pro",name:"Pro"},subscription:{status:"active",provider:"paddle",currentPeriodEnd:new Date().toISOString()},usage:{devices:1}},
 "/api/public/downloads":{available:false,releaseUrl:"https://github.com/orhanbal/webrising-commender/releases",tagName:null,assets:[]},
 "/api/auth/organizations":{items:[{id:"aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa",name:"Test Workspace",role:"owner"}]},
 "/api/organization":{item:{id:"aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa",name:"Test Workspace"}},
 "/api/tokens":{items:[{id:"22222222-2222-4222-8222-222222222222",name:"Test MCP",role:"operator",created_at:new Date().toISOString(),last_used_at:null,revoked_at:null}]},
 "/api/device/request":{ok:true,data:{status:"ok",entries:["readme.txt","documents"]}},
 "/api/pairing":{pairingCode:"wc-ci-pairing-code",expiresInSeconds:600},
 "/api/approvals":{approvalToken:"approved-ci-token"},

};
const contentType={".js":"text/javascript",".css":"text/css",".svg":"image/svg+xml",".png":"image/png",".woff2":"font/woff2"};
const server=createServer((req,res)=>{
 const pathname=new URL(req.url,"http://localhost").pathname;
 const respond=(code,body,typ="application/json")=>{res.writeHead(code,{"content-type":typ});res.end(body)};
 if(pathname.startsWith("/api/"))return respond(fixtures[pathname]?200:404,JSON.stringify(fixtures[pathname]||{error:"not_found"}));
 if(pathname.startsWith("/modern/assets/")){
  const file=resolve(root,"assets",pathname.slice("/modern/assets/".length));
  if(!file.startsWith(join(root,"assets")+ "/")||!existsSync(file))return respond(404,"");
  return respond(200,readFileSync(file),contentType[extname(file)]||"application/octet-stream");
 }
 if(pathname.startsWith("/assets/wecommander-")){
  const name=pathname.split("/").at(-1);
  const file=resolve(root,"../../public/assets",name);
  if(!existsSync(file))return respond(404,"");
  return respond(200,readFileSync(file),"image/svg+xml");
 }
 return respond(200,readFileSync(join(root,"index.html")),"text/html; charset=utf-8");
});
await new Promise(ok=>server.listen(0,"127.0.0.1",ok));
const chrome=["google-chrome","google-chrome-stable","chromium","chromium-browser"].find(bin=>spawnSync("which",[bin]).status===0);
assert.ok(chrome,"Chrome must be installed in CI");
const profile=mkdtempSync(join(tmpdir(),"wc-modern-"));
const proc=spawn(chrome,["--headless=new","--no-sandbox","--disable-dev-shm-usage","--disable-gpu","--remote-allow-origins=*","--remote-debugging-port=0","--user-data-dir="+profile,"about:blank"],{stdio:"ignore"});
const pending=new Map();let id=0;let ws;
try{
 let port=0;
 for(let i=0;i<600;i++){try{port=Number(readFileSync(join(profile,"DevToolsActivePort"),"utf8").split("\n")[0]);if(port)break}catch{}await sleep(100)}
 assert.ok(port,"Chrome DevTools timeout");
 const list=await(await fetch("http://127.0.0.1:"+port+"/json/list")).json();
 ws=new WebSocket(list.find(x=>x.type==="page").webSocketDebuggerUrl);
 await new Promise((ok,fail)=>{ws.addEventListener("open",ok,{once:true});ws.addEventListener("error",fail,{once:true})});
 ws.addEventListener("message",event=>{const m=JSON.parse(event.data);const p=pending.get(m.id);if(p){pending.delete(m.id);m.error?p.reject(Error(JSON.stringify(m.error))):p.resolve(m.result)}});
 const call=(method,params={})=>new Promise((resolve,reject)=>{const key=++id;pending.set(key,{resolve,reject});ws.send(JSON.stringify({id:key,method,params}))});
 const evalJs=async expression=>{const r=await call("Runtime.evaluate",{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result?.value};
 await call("Page.enable");await call("Runtime.enable");
 await call("Emulation.setDeviceMetricsOverride",{width:1440,height:900,deviceScaleFactor:1,mobile:false});
 await call("Emulation.setEmulatedMedia",{features:[{name:"prefers-color-scheme",value:"dark"}]});
 async function visit(page,keyword,screenshot){
  await call("Page.navigate",{url:"http://127.0.0.1:"+server.address().port+page});
  let state;
  for(let i=0;i<110;i++){await sleep(100);state=await evalJs("({text:document.querySelector('#root')?.textContent||'',overflow:document.documentElement.scrollWidth-innerWidth,hasLogo:!!document.querySelector('.logo-light'),title:document.title})");if(state.text.includes(keyword)&&state.hasLogo)break}
  assert.ok(state?.text.includes(keyword),page+" failed to render "+keyword+": "+JSON.stringify(state).slice(0,300));
  assert.ok(state.overflow<=2,page+" horizontally overflowed");
  const image=await call("Page.captureScreenshot",{format:"png",captureBeyondViewport:false});
  writeFileSync(join(artifacts,screenshot+".png"),Buffer.from(image.data,"base64"));
 }
 await visit("/","Tüm cihazların","modern-landing-dark");
 // Reference acceptance: exactly one guest sign-in and one blue Install CTA.
 const signedIn=fixtures["/api/auth/me"];
 delete fixtures["/api/auth/me"];
 await visit("/","Tüm cihazların","modern-landing-guest");
 const guestHeader=await evalJs("(()=>{const h=document.querySelector('.site-header');const buttons=[...h.querySelectorAll('button')];return {login:buttons.filter(b=>b.textContent.trim()==='Giriş Yap').length,install:buttons.filter(b=>b.textContent.includes('Install')).length}})()");
 assert.equal(guestHeader.login,1,"Guest header must not render duplicate sign-in actions");
 assert.equal(guestHeader.install,1,"Header must show one Install CTA");
 await evalJs("document.querySelector('.wc-nav-install').click()");
 for(let i=0;i<60;i++){await sleep(80);if(await evalJs("location.pathname==='/install' && document.querySelectorAll('.install-client-card').length===2"))break}
 assert.equal(await evalJs("location.pathname"),"/install","Install button must navigate to /install");
 assert.equal(await evalJs("document.querySelectorAll('.install-client-card').length"),2,"Install shows ChatGPT and Claude cards");
 const installShot=await call("Page.captureScreenshot",{format:"png",captureBeyondViewport:false});
 writeFileSync(join(artifacts,"modern-install-guest-dark.png"),Buffer.from(installShot.data,"base64"));
 await evalJs("document.querySelector('.install-client-action').click()");
 await sleep(160);
 assert.ok(await evalJs("document.querySelector('[role=dialog]')?.textContent.includes('ChatGPT')"),"ChatGPT setup must open actionable guide");
 await visit("/install","Konuştuğun yerde","modern-install-desktop");
 assert.equal(await evalJs("document.querySelectorAll('.install-platform').length"),3,"Install offers three operating systems");
 await evalJs("document.querySelector('.install-platforms button:nth-child(2)').click()");
 assert.ok(await evalJs("document.querySelector('.install-code-wrap pre')?.textContent.includes('target/release/webrising-commender')"),"macOS guide must show build command");
 await evalJs("document.querySelector('.install-option-head').click()");
 assert.ok(await evalJs("document.querySelector('.install-copy-field')?.textContent.includes('/mcp')"),"Remote MCP endpoint must be copyable");
 await evalJs("document.querySelector('.theme-button').click()");
 await sleep(130);
 assert.equal(await evalJs("document.documentElement.classList.contains('light')"),true,"Install light mode toggle failed");
 const installLight=await call("Page.captureScreenshot",{format:"png",captureBeyondViewport:false});
 writeFileSync(join(artifacts,"modern-install-light.png"),Buffer.from(installLight.data,"base64"));
 // Restore dark before the pre-existing landing light-mode acceptance.
 await evalJs("document.querySelector('.theme-button').click()");
 await sleep(90);
 assert.equal(await evalJs("document.documentElement.classList.contains('light')"),false);
 fixtures["/api/auth/me"]=signedIn;
 await visit("/","Tüm cihazların","modern-landing-dark");

 await evalJs("document.querySelector('.theme-button').click()");
 await sleep(200);
 assert.equal(await evalJs("document.documentElement.classList.contains('light')"),true,"Windows light mode toggle broken");
 let image=await call("Page.captureScreenshot",{format:"png",captureBeyondViewport:false});
 writeFileSync(join(artifacts,"modern-landing-light.png"),Buffer.from(image.data,"base64"));
 await visit("/login","Tekrar hoş geldiniz","modern-login");
 await visit("/register","Hesabınızı oluşturun","modern-register");
 await visit("/forgot-password","Şifrenizi sıfırlayın","modern-forgot-password");
 await visit("/pricing","Self-hosted","modern-pricing");
 await visit("/checkout?plan=pro","Paddle","modern-checkout");
 await visit("/dashboard","Tekrar hoş geldin","modern-dashboard");
 await visit("/billing","Paket ve Faturalama","modern-billing");
 await visit("/devices","Bağlı Makineler","modern-devices");
 await visit("/terminal","Çalışma Ortamı","modern-terminal");
 await visit("/files","Dosyaları Listele","modern-files");
 await visit("/tasks","Aktif Görevleri Listele","modern-tasks");
 await visit("/mcp","API Erişim Anahtarları","modern-mcp");
 await visit("/usage","Kullanım ve Raporlar","modern-usage");
 await visit("/account","Şifremi Değiştir","modern-account");
 await visit("/features","Cihaz yönetiminde","modern-features-scroll");
 assert.equal(await evalJs("location.hash"),"","Landing section URLs must have no hash");
 await visit("/how-it-works","Karmaşıklığı kaldır","modern-how-it-works");
 await call("Emulation.setDeviceMetricsOverride",{width:390,height:844,deviceScaleFactor:1,mobile:true});
 await visit("/","Tüm cihazların","modern-landing-mobile");
 await visit("/dashboard","Tekrar hoş geldin","modern-dashboard-mobile");
 await visit("/devices","Bağlı Makineler","modern-devices-mobile");
 await visit("/install","Konuştuğun yerde","modern-install-mobile");
 assert.ok(await evalJs("document.querySelector('.wc-nav-install')!==null"),"Mobile Install CTA missing");
 await visit("/account","Şifremi Değiştir","modern-account-mobile");
 console.log("PASS modern shadcn landing, account, device/workbench, usage, pricing, checkout and billing desktop/mobile");
}finally{ws?.close();proc.kill("SIGTERM");server.close();try{rmSync(profile,{recursive:true,force:true})}catch{}}
