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
 "/api/public/plans":{mode:"saas",paddle:{clientToken:null,checkoutEnabled:false,environment:"sandbox"},plans:[{key:"pro",name:"Pro",description:"Example test plan",featured:true,priceLabel:"$12 / month",priceId:null,features:["5 devices"],maxDevices:5,maxMembers:2,maxApiTokens:4}]},
 "/api/devices":{items:[{id:"11111111-1111-4111-8111-111111111111",name:"Test Windows Device",platform:"windows",online:true,last_seen_at:new Date().toISOString()}]},
 "/api/usage":{monthCalls:42,limit:100,dailyAverage:6,resetAt:"2026-11-01T00:00:00Z",daily:[1,2,3,4,5,6,7].map((n)=>({day:"2026-10-"+String(10+n),calls:n*2})),months:[],topTools:[]},
 "/api/activity":{items:[{tool:"direct.command",outcome:"success",created_at:new Date().toISOString()}]},
 "/api/billing":{mode:"saas",entitled:true,plan:{key:"pro",name:"Pro"},subscription:{status:"active",provider:"paddle",currentPeriodEnd:new Date().toISOString()},usage:{devices:1}},
 "/api/billing/support-requests":{items:[{id:"123e4567-e89b-42d3-a456-426614174000",type:"refund",message:"Please review my payment",status:"pending",resolution_note:"",created_at:new Date().toISOString()}]},
 "/api/public/downloads":{available:false,releaseUrl:"https://github.com/orhanbal/webrising-commender/releases",tagName:null,assets:[]},
 "/api/public/site-content":{item:null},
 "/api/console/me":{email:"test@example.com",userId:"eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",platformRole:"super_admin"},
 "/api/console/overview":{users:4,organizations:2,devices:1,activeDevices:1},
 "/api/console/users":{items:[{id:"44444444-4444-4444-8444-444444444444",email:"member@example.test",disabled:false,verified:true,workspace_count:1}]},
 "/api/console/users/detail":{user:{id:"44444444-4444-4444-8444-444444444444",email:"member@example.test",disabled:false,verified:true,platform_administrator:false,created_at:"2026-10-01T10:00:00.000Z",last_login_at:null,active_sessions:1,revoked_sessions:0},organizations:[{id:"aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa",name:"Test Workspace",role:"viewer",created_at:"2026-10-01T10:00:00.000Z"}]},
 "/api/console/organizations":{items:[{id:"aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa",name:"Test Workspace",members:2,devices:1,quota_overrides:{}}]},
 "/api/console/organizations/members":{items:[{user_id:"55555555-5555-4555-8555-555555555555",email:"member@example.test",role:"viewer",disabled:false}]},
 "/api/console/devices":{items:[{id:"11111111-1111-4111-8111-111111111111",name:"Test Windows Device",organization_name:"Test Workspace",platform:"windows"}],total:1,limit:25,offset:0},
 "/api/console/audit":{items:[{item_id:"platform:1",tool:"membership.role_change",outcome:"success",risk:"high",source:"platform",organization_name:"WECOMMANDER Platform"}],total:1,limit:25,offset:0},
 "/api/console/billing":{plans:[{key:"pro",name:"Pro",max_devices:5,max_members:2,max_api_tokens:4,active:true}],subscriptions:[]},
 "/api/console/billing/requests":{items:[{id:"123e4567-e89b-42d3-a456-426614174000",organization:"Test Workspace",requested_by_email:"test@example.com",type:"refund",message:"Please review my payment",status:"pending",resolution_note:"",created_at:new Date().toISOString()}]},
 "/api/console/system":{mailConfigured:false,signupEnabled:false,deploymentMode:"saas",mailQueue:{pending:0,delivered:0,failed:0}},
 "/api/console/incidents":{items:[]},
 "/api/console/site-content":{items:[]},
 "/api/console/media":{items:[]},
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
 if(pathname.startsWith("/api/public/brand/")){
  const fallback={logo_light:"wecommander-white.svg",logo_dark:"wecommander-black.svg",favicon:"wecommander-favicon.svg"}[pathname.split("/").at(-1)];
  if(!fallback)return respond(404,"");
  const file=resolve(root,"../../public/assets",fallback);
  return existsSync(file)?respond(200,readFileSync(file),"image/svg+xml"):respond(404,"");
 }
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
 await visit("/","All your devices.","modern-landing-dark");
 // Reference acceptance: exactly one guest sign-in and one blue Install CTA.
 const signedIn=fixtures["/api/auth/me"];
 delete fixtures["/api/auth/me"];
 await visit("/","All your devices.","modern-landing-guest");
 const guestHeader=await evalJs("(()=>{const h=document.querySelector('.site-header');const buttons=[...h.querySelectorAll('button')];return {login:buttons.filter(b=>b.textContent.trim()==='Sign in').length,install:buttons.filter(b=>b.textContent.includes('Install')).length}})()");
 assert.equal(guestHeader.login,1,"Guest header must not render duplicate sign-in actions");
 assert.equal(guestHeader.install,1,"Header must show one Install CTA");
 assert.equal(await evalJs("document.documentElement.lang"),"en","English must be the default regardless of browser language");
 assert.ok(await evalJs("document.querySelector('.site-header .locale-trigger')?.textContent.includes('English (EN)')"),"English is selected by default");
 await evalJs("document.querySelector('.site-header .locale-trigger').click()");
 await evalJs("document.querySelector('.site-header .locale-option[role=menuitemradio]:last-child').click()");
 await sleep(120);
 assert.equal(await evalJs("document.documentElement.lang"),"tr","Switching to Turkish must update html lang");
 assert.ok(await evalJs("document.querySelector('h1')?.textContent.includes('Tüm cihazların.')"),"Turkish landing translation was not applied");
 assert.equal(await evalJs("localStorage.getItem('wecommander-language')"),"tr","Locale selection must be persisted");
 const turkishImage=await call("Page.captureScreenshot",{format:"png",captureBeyondViewport:false});
 writeFileSync(join(artifacts,"modern-landing-turkish.png"),Buffer.from(turkishImage.data,"base64"));
 await visit("/","Tüm cihazların.","modern-landing-turkish-persisted");
 assert.equal(await evalJs("document.querySelector('.site-header .locale-trigger')?.textContent.includes('Türkçe (TR)')"),true,"Language must survive page navigation");
 await evalJs("document.querySelector('.site-header .locale-trigger').click()");
 await evalJs("document.querySelector('.site-header .locale-option[role=menuitemradio]:first-child').click()");
 await sleep(120);
 assert.ok(await evalJs("document.querySelector('h1')?.textContent.includes('All your devices.')"),"Reverting to English must restore native copy");
 assert.equal(await evalJs("localStorage.getItem('wecommander-language')"),"en");

 await evalJs("document.querySelector('.wc-nav-install').click()");
 for(let i=0;i<60;i++){await sleep(80);if(await evalJs("location.pathname==='/install' && document.querySelectorAll('.install-client-card').length===2"))break}
 assert.equal(await evalJs("location.pathname"),"/install","Install button must navigate to /install");
 assert.equal(await evalJs("document.querySelectorAll('.install-client-card').length"),2,"Install shows ChatGPT and Claude cards");
 const installShot=await call("Page.captureScreenshot",{format:"png",captureBeyondViewport:false});
 writeFileSync(join(artifacts,"modern-install-guest-dark.png"),Buffer.from(installShot.data,"base64"));
 await evalJs("document.querySelector('.install-client-action').click()");
 await sleep(160);
 assert.ok(await evalJs("document.querySelector('[role=dialog]')?.textContent.includes('ChatGPT')"),"ChatGPT setup must open actionable guide");
 await visit("/install","Use it where you","modern-install-desktop");
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
 await visit("/","All your devices.","modern-landing-dark");

 await evalJs("document.querySelector('.theme-button').click()");
 await sleep(200);
 assert.equal(await evalJs("document.documentElement.classList.contains('light')"),true,"Windows light mode toggle broken");
 let image=await call("Page.captureScreenshot",{format:"png",captureBeyondViewport:false});
 writeFileSync(join(artifacts,"modern-landing-light.png"),Buffer.from(image.data,"base64"));
 await visit("/login","Welcome back","modern-login");
 await visit("/register","Create your account","modern-register");
 await visit("/forgot-password","Reset your password","modern-forgot-password");
 await visit("/pricing","Self-hosted","modern-pricing");
 await visit("/checkout?plan=pro","Paddle","modern-checkout");
 await visit("/dashboard","Welcome back","modern-dashboard");
 const languagePicker=await evalJs("document.querySelector('.dash-toolbar .locale-trigger')!==null");
 assert.equal(languagePicker,true,"Dashboard needs its own language picker");
 await evalJs("document.querySelector('.dash-toolbar .locale-trigger').click()");
 await evalJs("document.querySelector('.dash-toolbar .locale-option[role=menuitemradio]:last-child').click()");
 await sleep(110);
 assert.ok(await evalJs("document.body.textContent.includes('Tekrar hoş geldin')"),"Dashboard must switch to Turkish");
 await evalJs("document.querySelector('.dash-toolbar .locale-trigger').click()");
 await evalJs("document.querySelector('.dash-toolbar .locale-option[role=menuitemradio]:first-child').click()");
 await sleep(110);
 assert.ok(await evalJs("document.body.textContent.includes('Welcome back')"),"Dashboard must switch back to English");
 assert.equal(await evalJs("document.documentElement.lang"),"en");

 await visit("/billing","Plans & billing","modern-billing");
 assert.ok(await evalJs("document.body.textContent.includes('Cancellation')||document.body.textContent.includes('Abonelik talepleri')"),"Owner billing view must expose cancellation/refund request form");
 await visit("/devices","Connected machines","modern-devices");
 await visit("/terminal","Workspace","modern-terminal");
 await visit("/files","List files","modern-files");
 await visit("/tasks","List active tasks","modern-tasks");
 await visit("/mcp","API access tokens","modern-mcp");
 await visit("/usage","Usage & reports","modern-usage");
 await visit("/account","Change password","modern-account");
 await visit("/console","Platform Overview","modern-console-overview");
 assert.equal(await evalJs("document.querySelectorAll('aside .dash-nav button').length"),10,"Console navigation should expose all configured sections");
 await evalJs("document.querySelector('.dash-toolbar .locale-trigger').click()");
 await evalJs("document.querySelector('.dash-toolbar .locale-option[role=menuitemradio]:last-child').click()");
 await sleep(120);
 assert.equal(await evalJs("document.documentElement.lang"),"tr","Super admin locale must change");
 assert.ok(await evalJs("document.body.textContent.includes('Genel Bakış')&&document.body.textContent.includes('Platform araçları')"),"Super admin overview should be translated");
 await evalJs("document.querySelector('.dash-toolbar .locale-trigger').click()");
 await evalJs("document.querySelector('.dash-toolbar .locale-option[role=menuitemradio]:first-child').click()");
 await sleep(120);

 await visit("/console/users","Users","modern-console-users");
 await evalJs("document.querySelector('.dash-toolbar .locale-trigger').click()");
 await evalJs("document.querySelector('.dash-toolbar .locale-option[role=menuitemradio]:last-child').click()");
 await sleep(120);
 assert.ok(await evalJs("document.querySelector('th')?.textContent.includes('Kayıt kimliği')"),"Admin table column names are localized into Turkish");
 await evalJs("document.querySelector('.dash-toolbar .locale-trigger').click()");
 await evalJs("document.querySelector('.dash-toolbar .locale-option[role=menuitemradio]:first-child').click()");
 await sleep(120);

 await evalJs("([...document.querySelectorAll('button')].find(x=>x.textContent.trim()==='Details'))?.click()");
 await sleep(150);
 assert.ok(await evalJs("document.querySelector('[role=dialog]')?.textContent.includes('member@example.test')"),"User details show the selected account");
 assert.ok(await evalJs("document.querySelector('[role=dialog]')?.textContent.includes('Test Workspace')"),"User details must include workspace memberships");
 assert.ok(await evalJs("!document.querySelector('[role=dialog]')?.textContent.includes('password_hash')"),"User details must not expose secrets");
 await evalJs("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");
 await sleep(90);
 assert.equal(await evalJs("document.querySelector('[role=dialog]')===null"),true,"Escape closes the user details modal");
 await visit("/console/organizations","Organizations","modern-console-organizations");
 assert.ok(await evalJs("!document.body.textContent.includes('[object Object]')"),"Workspace quota objects must be formatted for humans");
 await evalJs("([...document.querySelectorAll('button')].find(x=>x.textContent.trim()==='Members'))?.click()");
 await sleep(120);
 assert.ok(await evalJs("document.querySelector('[role=dialog]')?.textContent.includes('member@example.test')"),"Workspace member inspector must show server-backed members");
 await evalJs("([...document.querySelectorAll('[role=dialog] button')].find(x=>x.textContent.trim()==='Close'))?.click()");
 await evalJs("([...document.querySelectorAll('button')].find(x=>x.textContent.trim()==='Edit quotas'))?.click()");
 await sleep(100);
 assert.ok(await evalJs("(()=>{const dialog=document.querySelector('[role=dialog][aria-modal=true]');return !!dialog&&dialog.contains(document.activeElement)})()"),"Admin modal must capture keyboard focus");
 await evalJs("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");
 await sleep(90);
 assert.equal(await evalJs("document.querySelector('[role=dialog][aria-modal=true]')===null"),true,"Escape must close the admin dialog");

 await visit("/console/landing","Landing content editor","modern-console-landing");
 assert.ok(await evalJs("document.body.textContent.includes('Landing media library')"),"Landing CMS must expose uploaded-media management");
 await evalJs("(()=>{const s=[...document.querySelectorAll('select')].find(el=>[...el.options].some(o=>o.value==='FAQ'));if(!s)throw new Error('FAQ section selector missing');s.value='FAQ';s.dispatchEvent(new Event('change',{bubbles:true}))})()");
 await sleep(100);
 assert.equal(await evalJs("document.querySelectorAll('fieldset').length"),5,"CMS must show five correctly paired FAQ editor cards");
 assert.ok(await evalJs("[...document.querySelectorAll('fieldset')].every(f=>f.querySelectorAll('textarea').length===2)"),"Every FAQ editor card must have a question and answer");

 await visit("/console/system","System status","modern-console-system");
 assert.ok(await evalJs("document.body.textContent.includes('Active browser sessions')"),"System view must show live operational counters");
 assert.ok(await evalJs("document.body.textContent.includes('Incident triage')"),"System view must expose audited incident triage");
 assert.ok(await evalJs("document.body.textContent.includes('Branded SMTP')"),"System view must show a credential-safe configuration summary");
 await visit("/console/devices","Devices","modern-console-devices");
 assert.ok(await evalJs("document.querySelector('input[aria-label=\"Search devices\"]')!==null"),"Device inventory should have a name/platform/workspace search");
 assert.equal(await evalJs("document.querySelectorAll('select[aria-label=\"Device status\"] option').length"),3,"Device state filtering must be explicit");
 await visit("/console/operations","Operations","modern-console-operations");
 assert.ok(await evalJs("document.querySelector('input[aria-label=\"Search audit records\"]')!==null"),"Audit table needs its own search box");
 assert.equal(await evalJs("document.querySelectorAll('select[aria-label=\"Audit source\"] option').length"),3,"Audit source filter lists tenant/platform");
 assert.ok(await evalJs("document.body.textContent.includes('membership.role_change')"),"Platform audit entries must appear in the operations feed");
 await visit("/console/billing","Subscriptions","modern-console-billing");
 assert.ok(await evalJs("document.body.textContent.includes('Cancellation & refund requests')"),"Super admin must expose support-request queue");
 await visit("/console/brand","Brand assets","modern-console-brand");
 await evalJs("(()=>{const field=document.querySelector('input[type=file]');const svg='<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"60\" height=\"40\"><rect width=\"60\" height=\"40\" fill=\"red\"/></svg>';const dt=new DataTransfer();dt.items.add(new File([svg],'fixture.svg',{type:'image/svg+xml'}));field.files=dt.files;field.dispatchEvent(new Event('change',{bubbles:true}))})()");
 // SVG decoding and canvas rasterization are asynchronous in headless Chrome.
 // Poll the actual preview state rather than assuming a 300 ms GPU budget.
 let rasterReady=false;
 let rasterError="";
 for(let attempt=0;attempt<50;attempt++){
  rasterReady=await evalJs("document.querySelector('img[src^=\\\"data:image/png;base64,\\\"]')!==null");
  if(rasterReady)break;
  rasterError=await evalJs("document.querySelector('[role=alert]')?.textContent||''");
  if(rasterError)break;
  await sleep(100);
 }
 assert.ok(rasterReady,"SVG logo must become previewable raster PNG before upload"+(rasterError?": "+rasterError:" (timed out)"));

 await visit("/console/legal","Privacy & terms editor","modern-console-legal");
 await evalJs("document.querySelector('.dash-toolbar .locale-trigger').click()");
 await evalJs("document.querySelector('.dash-toolbar .locale-option[role=menuitemradio]:last-child').click()");
 await sleep(120);
 assert.ok(await evalJs("document.body.textContent.includes('Gizlilik ve kullanım koşulları editörü')"),"Legal CMS text should follow Turkish locale");
 await evalJs("document.querySelector('.dash-toolbar .locale-trigger').click()");
 await evalJs("document.querySelector('.dash-toolbar .locale-option[role=menuitemradio]:first-child').click()");
 await sleep(120);

 assert.ok(await evalJs("document.querySelectorAll('textarea').length>=1"),"Legal editor must have a text editor");
 await visit("/privacy","Privacy Policy","modern-privacy");
 await visit("/terms","Terms of Service","modern-terms");


 await visit("/features","A new standard in","modern-features-scroll");
 assert.equal(await evalJs("document.querySelectorAll('.features-grid .feature-card').length"),6,"Landing content cards must be present");
 assert.ok(await evalJs("([...document.querySelectorAll('.features-grid .feature-card')].every(el=>{const css=getComputedStyle(el);return css.opacity==='1'&&css.display!=='none'&&css.visibility!=='hidden'}))"),"Landing cards must never be hidden by reveal effects");
 assert.equal(await evalJs("location.hash"),"","Landing section URLs must have no hash");
 await visit("/how-it-works","Less complexity.","modern-how-it-works");
 assert.equal(await evalJs("document.querySelectorAll('.steps-grid .step').length"),3,"Landing content cards must be present");
 assert.ok(await evalJs("([...document.querySelectorAll('.steps-grid .step')].every(el=>{const css=getComputedStyle(el);return css.opacity==='1'&&css.display!=='none'&&css.visibility!=='hidden'}))"),"Landing cards must never be hidden by reveal effects");
 await call("Emulation.setDeviceMetricsOverride",{width:390,height:844,deviceScaleFactor:1,mobile:true});
 await visit("/","All your devices.","modern-landing-mobile");
 await visit("/dashboard","Welcome back","modern-dashboard-mobile");
 await visit("/devices","Connected machines","modern-devices-mobile");
 await visit("/install","Use it where you","modern-install-mobile");
 assert.ok(await evalJs("document.querySelector('.wc-nav-install')!==null"),"Mobile Install CTA missing");
 await visit("/account","Change password","modern-account-mobile");
 await visit("/console","Platform Overview","modern-console-mobile");
 assert.ok(await evalJs("document.querySelector('.mobile-dash-open')!==null"),"Mobile console navigation toggle must exist");

 console.log("PASS modern shadcn landing, account, device/workbench, usage, pricing, checkout and billing desktop/mobile");
}finally{ws?.close();proc.kill("SIGTERM");server.close();try{rmSync(profile,{recursive:true,force:true})}catch{}}
