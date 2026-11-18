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
const growthDays=Array.from({length:7},(_,i)=>new Date(Date.now()-(6-i)*864e5).toISOString().slice(0,10));
const fixtures={
 "/api/auth/me":{email:"test@example.com",actor:"test-user",role:"owner",authKind:"session",global:false,organizationId:"aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa"},
 "/api/public/plans":{mode:"saas",paddle:{clientToken:null,checkoutEnabled:false,environment:"sandbox"},plans:[{key:"pro",name:"Pro",description:"Example test plan",featured:true,priceLabel:"$12 / month",priceId:null,features:["5 devices"],maxDevices:5,maxMembers:2,maxApiTokens:4}]},
 "/api/devices":{items:[{id:"11111111-1111-4111-8111-111111111111",name:"Test Windows Device",platform:"windows",online:true,last_seen_at:new Date().toISOString(),trust_level:"standard",trust_full_until:null}]},
 "/api/members":{items:[{id:"55555555-5555-4555-8555-555555555555",email:"test@example.com",role:"owner",last_login_at:new Date().toISOString(),member_since:new Date().toISOString()},{id:"66666666-6666-4666-8666-666666666666",email:"ops@example.test",role:"operator",last_login_at:null,member_since:new Date().toISOString()}]},
 "/api/invitations":{items:[{id:"77777777-7777-4777-8777-777777777777",email:"new@example.test",role:"viewer",status:"pending",expires_at:new Date(Date.now()+72*3600e3).toISOString(),created_at:new Date().toISOString()}]},
 "/api/audit":{items:[{id:"1",actor:"oauth:claude",device_id:"11111111-1111-4111-8111-111111111111",tool:"task_start",risk:"high",outcome:"approval_pending",detail:null,created_at:new Date().toISOString()},{id:"2",actor:"user:test@example.com",device_id:"11111111-1111-4111-8111-111111111111",tool:"approval_request.approve",risk:"high",outcome:"success",detail:"{}",created_at:new Date().toISOString()}]},
 "/api/organization":{item:{id:"org",name:"Test",relay_region:null}},
 "/api/relay-regions":{enabled:true,items:[{region:"eu-central",nodes:2}]},
 "/api/device/request":{ok:true,data:{status:"ok",entries:["readme.txt","documents"],path:"/srv/work",encoding:"utf8",content:"hello\n",size:6,items:[{name:"notes.txt",path:"/srv/work/notes.txt",type:"file",size:6,taskId:"88888888-8888-4888-8888-888888888888",status:"completed",createdAtMs:"1793860578641"}]}},
 "/api/approval-requests":{items:[{id:"22222222-2222-4222-8222-222222222222",device_id:"11111111-1111-4111-8111-111111111111",requested_by:"oauth:claude",action_kind:"process_exec",action:{kind:"process_exec",command:"systemctl restart nginx",timeoutMs:30000},status:"pending",expires_at:new Date(Date.now()+9*60000).toISOString(),created_at:new Date().toISOString()}]},
 "/api/devices/11111111-1111-4111-8111-111111111111/command-allowlist":{items:[{id:"33333333-3333-4333-8333-333333333333",pattern:"df -h",created_at:new Date().toISOString()}]},
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
 "/api/console/growth/overview":{days:7,range:growthDays,visits:{total:120,series:[10,20,15,30,12,18,15]},pageViews:300,aiVisits:{total:22,series:[1,3,2,5,4,3,4]},downloads:{total:40,series:[5,6,7,4,8,5,5],byPlatform:[],allTime:1800},signups:{total:9,series:[1,2,1,0,3,1,1]},active:{dau:5,wau:20,mau:61},devices:{online:3,active7d:11},nps:{score:42,responses:17}},
 "/api/console/growth/traffic":{days:7,range:growthDays,visits:{total:120,series:[10,20,15,30,12,18,15]},pageViews:{total:300,series:[30,40,35,60,42,48,45]},buckets:[{key:"search",count:60},{key:"ai",count:22},{key:"direct",count:30}],ai:[{key:"ChatGPT",count:12},{key:"Claude",count:8},{key:"Perplexity",count:2}],aiSeries:[1,3,2,5,4,3,4],sources:[{bucket:"search",source:"Google",count:55},{bucket:"ai",source:"ChatGPT",count:12},{bucket:"other",source:"a-very-long-referrer-host-name-that-should-wrap.example.com",count:1}],pages:[{key:"/",count:200},{key:"/pricing",count:60}],landings:[{key:"/",count:90}],utmSource:[{key:"chatgpt.com",count:9}],utmMedium:[],utmCampaign:[]},
 "/api/console/growth/crawlers":{days:7,range:growthDays,total:90,series:[10,12,14,11,15,13,15],crawlers:[{key:"GPTBot",count:40,series:[5,6,7,5,6,5,6]},{key:"ClaudeBot",count:30,series:[4,4,4,5,4,4,5]}],paths:[{key:"/llms.txt",count:20},{key:"/sitemap.xml",count:10}],detail:[{crawler:"GPTBot",path:"/llms.txt",count:12}]},
 "/api/console/growth/connections":{days:7,range:growthDays,clients:[{kind:"claude",users:14,workspaces:11,newUsers:3,lastConnected:new Date().toISOString()},{kind:"chatgpt",users:6,workspaces:6,newUsers:1,lastConnected:new Date().toISOString()}],calls:[{key:"claude",count:420,series:[50,60,70,60,60,60,60]}],callSeries:[50,60,70,60,60,60,60]},
 "/api/console/growth/downloads":{days:7,range:growthDays,live:{total:1800,byPlatform:{windows:1200,macos:400,linux:200},byFormat:{"windows:zip":1200,"macos:zip":400,"linux:deb":200},byVersion:[{tag:"ubuntu-preview-1835",total:300,publishedAt:new Date().toISOString()}]},daily:{total:40,series:[5,6,7,4,8,5,5],byPlatform:[{key:"windows",count:30}]},installs:{total:12,series:[1,2,2,1,3,2,1],byScript:[{key:"/install.sh",count:8}]}},
 "/api/console/growth/usage":{days:7,range:growthDays,active:{dau:5,wau:20,mau:61},signups:{total:9,series:[1,2,1,0,3,1,1]},appsDaily:[3,4,5,4,6,5,5],appsByPlatform:[{key:"windows",count:6}],appsByVersion:[{key:"windows 1.2.3",count:6}],appsByLanguage:[{key:"tr",count:4}],devices:[{platform:"linux",total:9,online:3,active7d:7}],retention:[{week:"2026-10-05",signups:4,d7Eligible:4,d7:2,d7Rate:50,d30Eligible:4,d30:1,d30Rate:25}],funnel:[{step:"visits",count:120},{step:"downloads",count:52},{step:"signups",count:9},{step:"first_device",count:4},{step:"paid",count:1}]},
 "/api/console/growth/feedback":{days:7,nps:{score:42,responses:17,distribution:[{score:9,n:10},{score:3,n:2}],trend:[{week:"2026-11-09",score:40,responses:8}]},csat:{average:4.4,responses:12},comments:[{kind:"nps",title:"How likely",score:9,comment:"Works great with Claude",platform:"windows",updatedAt:new Date().toISOString()}],errors:[{message:"Connection reset while reading the terminal stream from the agent",total:3,lastAt:new Date().toISOString(),breakdown:[{platform:"windows",build:"1.2.3",count:3}]}]},
 "/api/console/growth/directories":{items:[{key:"mcp_registry",name:"Official MCP Registry",url:"https://registry.modelcontextprotocol.io",status:"listed",submittedAt:null,listingUrl:"https://registry.modelcontextprotocol.io/v0/servers?search=app.wecommander/wecommander",note:"",updatedAt:null},{key:"smithery",name:"Smithery",url:"https://smithery.ai",status:"not_submitted",submittedAt:null,listingUrl:null,note:"",updatedAt:null}],registry:{listed:true,version:"1.0.0",status:"active",publishedAt:new Date().toISOString(),updatedAt:null,checkedAt:new Date().toISOString(),error:null},kitUrl:"https://github.com/orhanbal/webrising-commender/blob/main/docs/DIRECTORY_SUBMISSIONS.md",kit:null},
 "/api/auth/organizations":{items:[{id:"aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa",name:"Test Workspace",role:"owner"}]},
 "/api/organization":{item:{id:"aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa",name:"Test Workspace"}},
 "/api/tokens":{items:[{id:"22222222-2222-4222-8222-222222222222",name:"Test MCP",role:"operator",created_at:new Date().toISOString(),last_used_at:null,revoked_at:null}]},
 "/api/pairing":{pairingCode:"wc-ci-pairing-code",expiresInSeconds:600},
 "/api/approvals":{approvalToken:"approved-ci-token"},
 "/api/trust/autonomy":{items:[{id:"11111111-1111-4111-8111-111111111111",name:"Test Windows Device",trust_full_until:null}]},
 "/api/scheduled-tasks":{items:[
  {id:"88888888-8888-4888-8888-888888888888",name:"Nightly backup",target:{kind:"device",deviceId:"11111111-1111-4111-8111-111111111111"},targetLabel:"Test Windows Device",command:"robocopy C:\\data D:\\backup /MIR",schedule:{kind:"cron",expr:"0 3 * * *"},timezone:"Europe/Istanbul",enabled:true,timeoutSec:600,notify:"failure",createdBy:"user:x",createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),nextRunAt:new Date(Date.now()+3600e3).toISOString(),lastRun:{id:"99999999-9999-4999-8999-999999999999",taskId:"88888888-8888-4888-8888-888888888888",scheduledFor:new Date().toISOString(),status:"failed",exitCode:2,runner:"agent",trigger:"schedule"}},
  {id:"88888888-8888-4888-8888-888888888889",name:"Disk report",target:{kind:"ssh",centerId:"33333333-3333-4333-8333-333333333333",hostId:"h1",hostLabel:"web-1.example.test"},command:"df -h",schedule:{kind:"interval",minutes:120},timezone:"UTC",enabled:false,timeoutSec:60,notify:"always",createdBy:"user:x",createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),nextRunAt:null}]},
 "/api/scheduled-tasks/preview":{next:[1,2,3,4,5].map(n=>new Date(Date.UTC(2026,10,17+n,0,0)).toISOString())},
 "/api/scheduled-tasks/88888888-8888-4888-8888-888888888888/runs":{items:[{id:"99999999-9999-4999-8999-999999999999",taskId:"88888888-8888-4888-8888-888888888888",scheduledFor:new Date().toISOString(),startedAt:new Date().toISOString(),finishedAt:new Date().toISOString(),status:"failed",exitCode:2,output:"ERROR 2: access denied",runner:"agent",trigger:"schedule"}]},
 "/api/centers":{items:[{id:"33333333-3333-4333-8333-333333333333",name:"Ofis-PC",email:"owner@example.test",created_at:new Date().toISOString(),last_seen_at:new Date().toISOString(),revoked_at:null}]},

};
const growthPages=[["/console/growth","AI-referred visits"],["/console/growth/traffic","Where visits come from"],["/console/growth/crawlers","What they read"],["/console/growth/connections","Connected AI clients"],["/console/growth/downloads","Install script fetches"],["/console/growth/usage","Retention by sign-up week"],["/console/growth/feedback","NPS score distribution"],["/console/growth/directories","AI app and plugin directories"]];
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
 await visit("/","in one app.","modern-landing-dark");
 // Reference acceptance: exactly one guest sign-in and one blue Install CTA.
 const signedIn=fixtures["/api/auth/me"];
 delete fixtures["/api/auth/me"];
 await visit("/","in one app.","modern-landing-guest");
 const guestHeader=await evalJs("(()=>{const h=document.querySelector('.site-header');const buttons=[...h.querySelectorAll('button')];return {login:buttons.filter(b=>b.textContent.trim()==='Sign in').length,install:buttons.filter(b=>b.textContent.includes('Install')).length}})()");
 assert.equal(guestHeader.login,1,"Guest header must not render duplicate sign-in actions");
 assert.equal(guestHeader.install,1,"Header must show one Install CTA");
 assert.equal(await evalJs("document.documentElement.lang"),"en","English must be the default regardless of browser language");
 assert.ok(await evalJs("document.querySelector('.site-header .locale-trigger')?.textContent.trim()==='EN'"),"English is selected by default");
 await evalJs("document.querySelector('.site-header .locale-trigger').click()");
 await evalJs("document.querySelector('.site-header .locale-option[role=menuitemradio]:nth-of-type(2)').click()");
 await sleep(120);
 assert.equal(await evalJs("document.documentElement.lang"),"tr","Switching to Turkish must update html lang");
 assert.ok(await evalJs("document.querySelector('h1')?.textContent.includes('tek uygulamada.')"),"Turkish landing translation was not applied");
 assert.equal(await evalJs("localStorage.getItem('wecommander-language')"),"tr","Locale selection must be persisted");
 const turkishImage=await call("Page.captureScreenshot",{format:"png",captureBeyondViewport:false});
 writeFileSync(join(artifacts,"modern-landing-turkish.png"),Buffer.from(turkishImage.data,"base64"));
 await visit("/","tek uygulamada.","modern-landing-turkish-persisted");
 assert.equal(await evalJs("document.querySelector('.site-header .locale-trigger')?.textContent.trim()==='TR'"),true,"Language must survive page navigation");
 await evalJs("document.querySelector('.site-header .locale-trigger').click()");
 await evalJs("document.querySelector('.site-header .locale-option[role=menuitemradio]:first-of-type').click()");
 await sleep(120);
 assert.ok(await evalJs("document.querySelector('h1')?.textContent.includes('in one app.')"),"Reverting to English must restore native copy");
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
 assert.ok(await evalJs("document.querySelector('.install-code-wrap pre')?.textContent===`curl -fsSL ${location.origin}/install.sh | sh`"),"macOS guide must show the one-line install command");
 await evalJs("document.querySelector('.install-platforms button:nth-child(1)').click()");
 assert.ok(await evalJs("document.querySelector('.install-code-wrap pre')?.textContent.includes(location.origin+'/install.ps1')"),"Windows guide must show the PowerShell one-line command");
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
 await visit("/","in one app.","modern-landing-dark");

 await evalJs("document.querySelector('.theme-button').click()");
 await sleep(200);
 assert.equal(await evalJs("document.documentElement.classList.contains('light')"),true,"Windows light mode toggle broken");
 let image=await call("Page.captureScreenshot",{format:"png",captureBeyondViewport:false});
 writeFileSync(join(artifacts,"modern-landing-light.png"),Buffer.from(image.data,"base64"));
 await visit("/login","Welcome back","modern-login");
 await visit("/register","Create your account","modern-register");
 await visit("/forgot-password","Reset your password","modern-forgot-password");
 await visit("/pricing","right plan.","modern-pricing");
 await visit("/checkout?plan=pro","Paddle","modern-checkout");
 await visit("/dashboard","Welcome back","modern-dashboard");
 assert.ok(await evalJs("document.querySelector('.autonomy-banner')?.textContent.includes('Autonomous mode is on')"),"Dashboard pages show the autonomous-mode banner");
 const languagePicker=await evalJs("document.querySelector('.dash-toolbar .locale-trigger')!==null");
 assert.equal(languagePicker,true,"Dashboard needs its own language picker");
 await evalJs("document.querySelector('.dash-toolbar .locale-trigger').click()");
 await evalJs("document.querySelector('.dash-toolbar .locale-option[role=menuitemradio]:nth-of-type(2)').click()");
 await sleep(110);
 assert.ok(await evalJs("document.body.textContent.includes('Tekrar hoş geldin')"),"Dashboard must switch to Turkish");
 await evalJs("document.querySelector('.dash-toolbar .locale-trigger').click()");
 await evalJs("document.querySelector('.dash-toolbar .locale-option[role=menuitemradio]:first-of-type').click()");
 await sleep(110);
 assert.ok(await evalJs("document.body.textContent.includes('Welcome back')"),"Dashboard must switch back to English");
 assert.equal(await evalJs("document.documentElement.lang"),"en");

 await visit("/billing","Plans & billing","modern-billing");
 assert.ok(await evalJs("document.body.textContent.includes('Subscription requests')&&document.body.textContent.includes('Refund request')"),"Owner billing view must expose cancellation/refund request form");
 await visit("/devices","Connected machines","modern-devices");
 await visit("/terminal","Interactive terminal","modern-terminal");
 assert.ok(await evalJs("[...document.querySelectorAll('button')].some(b=>b.textContent.includes('Open session'))"),"Terminal offers an interactive session");
 assert.equal(await evalJs("[...document.querySelectorAll('button')].some(b=>b.textContent.includes('Advanced console'))"),false,"No link to the legacy console");
 await visit("/files","notes.txt","modern-files");
 assert.ok(await evalJs("document.querySelectorAll('.file-list button').length>=1"),"Files browser lists entries");
 await evalJs("document.querySelector('.file-list button').click()");
 await sleep(400);
 assert.ok(await evalJs("!!document.querySelector('textarea.file-editor')"),"Opening a text file shows the editor");
 await visit("/tasks","New task","modern-tasks");
 assert.ok(await evalJs("document.body.textContent.includes('completed')"),"Tasks are listed with status");
 await visit("/mcp","API access tokens","modern-mcp");
 await visit("/usage","Usage & reports","modern-usage");
 await visit("/account","Change password","modern-account");
 await visit("/console","Platform Overview","modern-console-overview");
 assert.equal(await evalJs("document.querySelectorAll('aside .dash-nav button').length"),20,"Console navigation should expose all configured sections");
 await evalJs("document.querySelector('.dash-toolbar .locale-trigger').click()");
 await evalJs("document.querySelector('.dash-toolbar .locale-option[role=menuitemradio]:nth-of-type(2)').click()");
 await sleep(120);
 assert.equal(await evalJs("document.documentElement.lang"),"tr","Super admin locale must change");
 assert.ok(await evalJs("document.body.textContent.includes('Genel Bakış')&&document.body.textContent.includes('Son kayıtlar')"),"Super admin overview should be translated");
 await evalJs("document.querySelector('.dash-toolbar .locale-trigger').click()");
 await evalJs("document.querySelector('.dash-toolbar .locale-option[role=menuitemradio]:first-of-type').click()");
 await sleep(120);

 await visit("/console/users","Users","modern-console-users");
 await evalJs("document.querySelector('.dash-toolbar .locale-trigger').click()");
 await evalJs("document.querySelector('.dash-toolbar .locale-option[role=menuitemradio]:nth-of-type(2)').click()");
 await sleep(120);
 assert.ok(await evalJs("document.querySelector('th')?.textContent.includes('Kullanıcı')"),"Admin table column names are localized into Turkish");
 await evalJs("document.querySelector('.dash-toolbar .locale-trigger').click()");
 await evalJs("document.querySelector('.dash-toolbar .locale-option[role=menuitemradio]:first-of-type').click()");
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
 await evalJs("([...document.querySelectorAll('[role=dialog] button')].find(x=>x.textContent.trim()==='Recover as owner'))?.click()");
 await sleep(80);
 assert.ok(await evalJs("!!document.querySelector('[aria-label=\"Owner recovery\"]')"),"Owner recovery form must open from the member list");
 const grant="([...document.querySelectorAll('[role=dialog] button')].find(x=>x.textContent.trim()==='Grant owner role'))";
 assert.equal(await evalJs(grant+"?.disabled"),true,"Owner recovery stays disabled without reason and password");
 await evalJs("(()=>{const set=(el,v)=>{const p=Object.getPrototypeOf(el);Object.getOwnPropertyDescriptor(p,'value').set.call(el,v);el.dispatchEvent(new Event('input',{bubbles:true}))};const f=document.querySelector('[aria-label=\"Owner recovery\"]');set(f.querySelector('input[type=text]'),'short');set(f.querySelector('input[type=password]'),'correct-horse-battery-staple')})()");
 await sleep(60);
 assert.equal(await evalJs(grant+"?.disabled"),true,"A reason shorter than 10 characters keeps recovery disabled");
 await evalJs("(()=>{const el=document.querySelector('[aria-label=\"Owner recovery\"] input[type=text]');Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el),'value').set.call(el,'Ticket SUP-4711 owner lost access');el.dispatchEvent(new Event('input',{bubbles:true}))})()");
 await sleep(60);
 assert.equal(await evalJs(grant+"?.disabled"),false,"Reason and password enable owner recovery");
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
 assert.equal(await evalJs("document.querySelectorAll('fieldset').length"),9,"CMS must show nine correctly paired FAQ editor cards");
 assert.ok(await evalJs("[...document.querySelectorAll('fieldset')].every(f=>f.querySelectorAll('textarea').length===2)"),"Every FAQ editor card must have a question and answer");

 await visit("/console/system","System status","modern-console-system");
 assert.ok(await evalJs("document.body.textContent.includes('Active browser sessions')"),"System view must show live operational counters");
 assert.ok(await evalJs("document.body.textContent.includes('Incident triage')"),"System view must expose audited incident triage");
 assert.ok(await evalJs("document.body.textContent.includes('Branded SMTP')"),"System view must show a credential-safe configuration summary");
 for(const [page,keyword] of growthPages)await visit(page,keyword,"modern-"+page.slice(1).replaceAll("/","-"));
 assert.ok(await evalJs("document.body.textContent.includes('Smithery')"),"Directory statuses are listed");
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
  rasterReady=await evalJs("document.querySelector('img[src^=\"data:image/png;base64,\"]')!==null");
  if(rasterReady)break;
  rasterError=await evalJs("document.querySelector('[role=alert]')?.textContent||''");
  if(rasterError)break;
  await sleep(100);
 }
 assert.ok(rasterReady,"SVG logo must become previewable raster PNG before upload"+(rasterError?": "+rasterError:" (timed out)"));

 await visit("/console/legal","Privacy & terms editor","modern-console-legal");
 await evalJs("document.querySelector('.dash-toolbar .locale-trigger').click()");
 await evalJs("document.querySelector('.dash-toolbar .locale-option[role=menuitemradio]:nth-of-type(2)').click()");
 await sleep(120);
 assert.ok(await evalJs("document.body.textContent.includes('Gizlilik ve kullanım koşulları editörü')"),"Legal CMS text should follow Turkish locale");
 await evalJs("document.querySelector('.dash-toolbar .locale-trigger').click()");
 await evalJs("document.querySelector('.dash-toolbar .locale-option[role=menuitemradio]:first-of-type').click()");
 await sleep(120);

 assert.ok(await evalJs("document.querySelectorAll('textarea').length>=1"),"Legal editor must have a text editor");
 await visit("/privacy","Privacy Policy","modern-privacy");
 await visit("/terms","Terms of Service","modern-terms");


 await visit("/features","All your server work.","modern-features-scroll");
 assert.equal(await evalJs("document.querySelectorAll('.features-grid .feature-card').length"),9,"Landing content cards must be present");
 assert.ok(await evalJs("([...document.querySelectorAll('.features-grid .feature-card')].every(el=>{const css=getComputedStyle(el);return css.opacity==='1'&&css.display!=='none'&&css.visibility!=='hidden'}))"),"Landing cards must never be hidden by reveal effects");
 assert.equal(await evalJs("location.hash"),"","Landing section URLs must have no hash");
 // Landing v1.1: one-line install, comparison and FAQ are present and real.
 await visit("/","in one app.","modern-landing-sections");
 assert.ok(await evalJs("document.querySelector('.hero-install code')?.textContent===`curl -fsSL ${location.origin}/install.sh | sh`"),"Hero must show the one-line install command");
 assert.equal(await evalJs("document.querySelectorAll('.compare-table tbody tr').length"),6,"Comparison table must list six rows");
 assert.ok(await evalJs("document.querySelectorAll('#faq details').length>=6"),"FAQ must list the questions");
 assert.ok(await evalJs("!!document.querySelector('.session-preview figcaption')?.textContent.trim()"),"Session illustration needs a text alternative");
 await visit("/how-it-works","Ready in two minutes.","modern-how-it-works");
 assert.equal(await evalJs("document.querySelectorAll('.steps-grid .step').length"),3,"Landing content cards must be present");
 assert.ok(await evalJs("([...document.querySelectorAll('.steps-grid .step')].every(el=>{const css=getComputedStyle(el);return css.opacity==='1'&&css.display!=='none'&&css.visibility!=='hidden'}))"),"Landing cards must never be hidden by reveal effects");
 // WECOMMANDER scheduled tasks: list, schedule in words, history, required confirmation.
 await visit("/scheduled-tasks","Nightly backup","modern-scheduled-tasks");
 assert.equal(await evalJs("document.querySelector('.dash-nav a[href=\"/scheduled-tasks\"]')?.getAttribute('aria-current')"),"page","Scheduled tasks nav item must be current");
 assert.ok(await evalJs("document.querySelector('#root').textContent.includes('Every day at 03:00')"),"Cron schedule must be shown in words");
 assert.ok(await evalJs("document.querySelector('#root').textContent.includes('Every 2 hours')"),"Interval schedule must be shown in words");
 assert.ok(await evalJs("document.querySelector('#root').textContent.includes('web-1.example.test')"),"SSH host must be shown");
 await evalJs("[...document.querySelectorAll('button')].find(b=>b.getAttribute('aria-label')==='History: Nightly backup').click()");
 await sleep(400);
 await evalJs("[...document.querySelectorAll('[role=dialog] button[aria-expanded]')][0].click()");
 await sleep(150);
 assert.ok(await evalJs("document.querySelector('[role=dialog]')?.textContent.includes('ERROR 2: access denied')"),"Run output must be viewable");
 await evalJs("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");
 await sleep(300);
 await evalJs("[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='New task').click()");
 await sleep(900);
 assert.equal(await evalJs("document.querySelectorAll('[role=dialog] ol li').length"),5,"Live preview must list the next five runs");
 await evalJs("(()=>{const set=(el,v)=>{Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el),'value').set.call(el,v);el.dispatchEvent(new Event('input',{bubbles:true}))};const d=document.querySelector('[role=dialog]');set(d.querySelector('input'),'Cleanup');set(d.querySelector('textarea'),'find /var/tmp/cache -mtime +7 -delete');})()");
 await sleep(200);
 await evalJs("[...document.querySelectorAll('[role=dialog] button')].find(b=>b.textContent.trim()==='Continue').click()");
 await sleep(200);
 assert.ok(await evalJs("document.querySelector('[role=dialog] pre')?.textContent==='find /var/tmp/cache -mtime +7 -delete'"),"Confirmation must show the exact command");
 assert.ok(await evalJs("document.querySelector('[role=dialog]').textContent.includes('Test Windows Device')"),"Confirmation must show the target");
 assert.ok(await evalJs("[...document.querySelectorAll('[role=dialog] button')].some(b=>b.textContent.includes('Confirm and save'))"),"Saving needs the confirmation step");
 const scheduledShot=await call("Page.captureScreenshot",{format:"png",captureBeyondViewport:false});
 writeFileSync(join(artifacts,"modern-scheduled-task-confirm.png"),Buffer.from(scheduledShot.data,"base64"));
 // Approvals inbox and device policy (v1.1 item 5c).
 await visit("/approvals","Pending approvals","modern-approvals");
 assert.equal(await evalJs("document.querySelectorAll('.approval-item').length"),1,"Pending approval must be listed");
 assert.ok(await evalJs("document.querySelector('.approval-item .approval-op')?.textContent==='systemctl restart nginx'"),"Exact operation must be shown before deciding");
 assert.ok(await evalJs("document.querySelector('.approval-item')?.textContent.includes('Test Windows Device')"),"Device name must replace the device id");
 assert.equal(await evalJs("document.querySelector('.dash-nav a[href=\"/approvals\"]')?.getAttribute('aria-current')"),"page","Approvals nav item must be current");
 await evalJs("[...document.querySelectorAll('.approval-item button')].find(b=>b.textContent.includes('Approve')).click()");
 await sleep(150);
 assert.ok(await evalJs("document.querySelector('[role=dialog]')?.textContent.includes('systemctl restart nginx')"),"Approve dialog must repeat the exact operation");
 await evalJs("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");
 await evalJs("document.querySelector('[role=dialog] button[aria-label=Close]')?.click()");
 await sleep(150);
 assert.equal(await evalJs("document.querySelectorAll('.trust-option').length"),3,"Three trust levels must be offered");
 assert.ok(await evalJs("document.querySelector('.trust-option.active')?.textContent.includes('Standard')"),"Current trust level must be preselected");
 await evalJs("document.querySelector('.trust-option input[value=full]').click()");
 await sleep(80);
 assert.equal(await evalJs("document.querySelectorAll('input[autocomplete=current-password]').length"),2,"Full trust asks for the password (the autonomous-mode card has its own field)");
 assert.ok(await evalJs("document.body.textContent.includes('Autonomous mode')&&document.body.textContent.includes('Until 09:00 tomorrow')&&document.body.textContent.includes('Indefinite')"),"Autonomous mode card offers the duration presets");
 assert.ok(await evalJs("[...document.querySelectorAll('button')].some(b=>b.textContent.includes('Start autonomous mode')&&b.disabled)"),"Starting autonomous mode needs the password first");
 assert.equal(await evalJs("document.querySelector('.autonomy-banner')"),null,"The banner is not repeated on the approvals page");
 assert.ok(await evalJs("[...document.querySelectorAll('code')].some(c=>c.textContent==='df -h')"),"Allowed commands must be listed");
 assert.ok(await evalJs("document.body.textContent.includes('Management Centers')&&document.body.textContent.includes('Ofis-PC')"),"Connected Management Centers are listed");
 assert.ok(await evalJs("[...document.querySelectorAll('code')].some(c=>/^irm https?:\\/\\/[^ ]+\\/install\\.ps1 \\| iex$/.test(c.textContent))"),"The Windows app install command is shown");
 const approvalsShot=await call("Page.captureScreenshot",{format:"png",captureBeyondViewport:false});
 writeFileSync(join(artifacts,"modern-approvals-full-trust.png"),Buffer.from(approvalsShot.data,"base64"));

 // Team, audit and invitation pages (v1.1 item 5e).
 await visit("/team","Manage members","modern-team");
 assert.equal(await evalJs("document.querySelectorAll('.team-row').length"),3,"Two members and one invitation must be listed");
 assert.ok(await evalJs("document.body.textContent.includes('ops@example.test')&&document.body.textContent.includes('new@example.test')"),"Members and invitations are shown");
 assert.ok(await evalJs("!!document.querySelector('select[aria-label=Region]')"),"Owners can choose the relay region");
 await visit("/audit","Audit log","modern-audit");
 assert.equal(await evalJs("document.querySelectorAll('.console-table tbody tr').length"),2,"Audit entries are listed");
 assert.ok(await evalJs("document.querySelector('.console-table tbody')?.textContent.includes('Test Windows Device')"),"Device names replace ids");
 await call("Page.navigate",{url:"http://127.0.0.1:"+server.address().port+"/app#invite=wrci_legacy_link_token_value_0123456789abcdef"});
 await sleep(900);
 assert.equal(await evalJs("location.pathname"),"/app","legacy invitation links keep working");
 assert.ok(await evalJs("document.body.textContent.includes('Accept invitation')"),"legacy /app#invite= links open the invitation page");
 await call("Emulation.setDeviceMetricsOverride",{width:390,height:844,deviceScaleFactor:1,mobile:true});
 await visit("/","in one app.","modern-landing-mobile");
 await visit("/dashboard","Welcome back","modern-dashboard-mobile");
 await visit("/devices","Connected machines","modern-devices-mobile");
 await visit("/install","Use it where you","modern-install-mobile");
 assert.ok(await evalJs("document.querySelector('.wc-nav-install')!==null"),"Mobile Install CTA missing");
 await visit("/account","Change password","modern-account-mobile");
 await visit("/console","Platform Overview","modern-console-mobile");
 assert.ok(await evalJs("document.querySelector('.mobile-dash-open')!==null"),"Mobile console navigation toggle must exist");
 // Growth pages on a phone: charts, bar lists and tables must not overflow.
 for(const [page,keyword] of growthPages)await visit(page,keyword,"modern-"+page.slice(1).replaceAll("/","-")+"-mobile");

 // Smallest supported width (v1.1 item 5): no horizontal overflow on any shell.
 await call("Emulation.setDeviceMetricsOverride",{width:360,height:740,deviceScaleFactor:1,mobile:true});
 const clipped=()=>evalJs("(()=>{document.querySelectorAll('[data-reveal]').forEach(e=>e.classList.add('visible'));return [...document.querySelectorAll('.site-header *, .dash-topbar *, .hero-copy, .hero-copy *, .session-preview, .compare-wrap, .dash-content > *')].filter(e=>{const r=e.getBoundingClientRect();return r.width>0&&r.right>innerWidth+1}).map(e=>e.tagName+'.'+String(e.className).slice(0,30)).slice(0,5)})()");
 for(const [page,keyword,shot] of [["/","in one app.","modern-landing-360"],["/install","Use it where you","modern-install-360"],["/dashboard","Welcome back","modern-dashboard-360"],["/devices","Connected machines","modern-devices-360"],["/billing","Plans & billing","modern-billing-360"],["/approvals","Pending approvals","modern-approvals-360"],["/scheduled-tasks","Nightly backup","modern-scheduled-tasks-360"],["/console/users","Search accounts","modern-console-users-360"],["/team","Manage members","modern-team-360"],["/audit","Audit log","modern-audit-360"]]){await visit(page,keyword,shot);assert.deepEqual(await clipped(),[],page+" has elements wider than 360 px");}
 assert.equal(await evalJs("getComputedStyle(document.querySelector('.console-table thead')).display"),"none","Console tables collapse to cards on phones");
 assert.ok(await evalJs("[...document.querySelectorAll('.console-table td[data-label]')].length>0"),"Console card fields are labelled");
 await visit("/approvals","Pending approvals","modern-approvals-360-again");
 // Shell accessibility: a skip link to one main landmark, current page marked, drawer closes on Escape.
 assert.equal(await evalJs("document.querySelectorAll('main#main-content').length"),1,"Dashboard needs exactly one main landmark");
 assert.equal(await evalJs("document.querySelector('.skip-link')?.getAttribute('href')"),"#main-content","Skip link must target main content");
 assert.equal(await evalJs("document.querySelector('.dash-nav [aria-current=page]')?.getAttribute('href')"),"/approvals","Active nav item must carry aria-current");
 await evalJs("document.querySelector('.mobile-dash-open').click()");
 await sleep(120);
 assert.equal(await evalJs("document.querySelector('.dashboard-sidebar').classList.contains('open')"),true,"Mobile drawer must open");
 await evalJs("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}))");
 await sleep(120);
 assert.equal(await evalJs("document.querySelector('.dashboard-sidebar').classList.contains('open')"),false,"Escape must close the mobile drawer");
 await visit("/","in one app.","modern-landing-360-skip");
 assert.equal(await evalJs("document.querySelectorAll('main#main-content').length"),1,"Public pages need exactly one main landmark");

 console.log("PASS modern shadcn landing, account, device/workbench, usage, pricing, checkout and billing desktop/mobile");
}finally{ws?.close();proc.kill("SIGTERM");server.close();try{rmSync(profile,{recursive:true,force:true})}catch{}}
