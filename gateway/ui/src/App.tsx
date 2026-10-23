import {useEffect,useState} from "react";
import type {ReactNode} from "react";
import {ArrowUpRight,Command,Menu,Moon,ShieldCheck,Sun,X} from "lucide-react";
import {Button,Badge} from "./components/ui";
import {getMe,api,type Account,type Pricing} from "./api";
import {Landing} from "./pages/Landing";
import {AuthPage} from "./pages/Auth";
import {PlansPage} from "./pages/Plans";
import {DashboardPage} from "./pages/Dashboard";
import {BillingPage} from "./pages/Billing";
import {DevicesPage} from "./pages/Devices";
import {WorkspacePage} from "./pages/Workspace";
import {UsagePage} from "./pages/Usage";
import {AccountPage} from "./pages/Account";
import {InstallPage} from "./pages/Install";

export type Nav=(path:string)=>void;
export type Theme="light"|"dark";
const routes=new Set(["/","/features","/how-it-works","/login","/register","/forgot-password","/reset-password","/verify","/pricing","/checkout","/install","/dashboard","/account","/billing","/devices","/terminal","/files","/tasks","/mcp","/usage","/privacy","/terms"]);
export function Brand({onClick,subtitle=false}:{onClick?:()=>void;subtitle?:boolean}){return <a href="/" onClick={e=>{if(onClick){e.preventDefault();onClick()}}} aria-label="WECOMMANDER ana sayfa" className="inline-flex flex-col gap-1 items-start"><img className="logo-light" src="/assets/wecommander-white.svg" alt="WECOMMANDER"/><img className="logo-dark" src="/assets/wecommander-black.svg" alt="" aria-hidden="true"/>{subtitle&&<span className="text-[11px] tracking-wide text-[var(--muted)]">Remote MCP · AI Workspace</span>}</a>}
export function NavLink({to,nav,children,className}:{to:string;nav:Nav;children:ReactNode;className?:string}){return <a href={to} className={className} onClick={e=>{if(e.button===0&&!e.metaKey&&!e.ctrlKey&&!e.shiftKey&&!e.altKey){e.preventDefault();nav(to)}}}>{children}</a>}
export function ThemeToggle({theme,onToggle}:{theme:Theme;onToggle:()=>void}){return <button type="button" className="theme-button" onClick={onToggle} aria-label={theme==="dark"?"Açık temaya geç":"Koyu temaya geç"} title={theme==="dark"?"Windows açık tema":"Windows koyu tema"}>{theme==="dark"?<Sun className="size-[19px]"/>:<Moon className="size-[19px]"/>}</button>}
function getPath(){const p=window.location.pathname;if(p==="/app"||p==="/app/")return "/dashboard";return routes.has(p)?p:"/"}
export default function App(){
 const [path,setPath]=useState(getPath);
 const [theme,setTheme]=useState<Theme>(()=>{const saved=localStorage.getItem("wecommander-theme");return saved==="dark"||saved==="light"?saved:matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light"});
 const [account,setAccount]=useState<Account|null>(null);
 const [checking,setChecking]=useState(true);
 const [pricing,setPricing]=useState<Pricing|null>(null);
 const [signupEnabled,setSignupEnabled]=useState<boolean|null>(null);
 const [mobile,setMobile]=useState(false);
 useEffect(()=>{const fn=()=>{setPath(getPath());setMobile(false)};window.addEventListener("popstate",fn);return()=>window.removeEventListener("popstate",fn)},[]);
 useEffect(()=>{const mq=matchMedia("(prefers-color-scheme: dark)");const sync=()=>{if(!localStorage.getItem("wecommander-theme"))setTheme(mq.matches?"dark":"light")};mq.addEventListener("change",sync);return()=>mq.removeEventListener("change",sync)},[]);
 useEffect(()=>{document.documentElement.classList.toggle("light",theme==="light");document.documentElement.style.colorScheme=theme;document.querySelector('meta[name="theme-color"]')?.setAttribute("content",theme==="light"?"#f3f3f3":"#202020")},[theme]);
 useEffect(()=>{getMe().then(me=>{setAccount(me);setChecking(false)});api<Pricing>("/api/public/plans").then(setPricing).catch(()=>setPricing(null));api<{signupEnabled:boolean}>("/api/public/config").then(config=>setSignupEnabled(config.signupEnabled)).catch(()=>setSignupEnabled(null))},[]);
 const navigate:Nav=to=>{
  const u=new URL(to,location.origin);
  if(u.origin!==location.origin){location.assign(to);return}
  history.pushState(null,"",u.pathname+u.search+u.hash);
  setPath(getPath());setMobile(false);
  if(u.pathname==="/features"||u.pathname==="/how-it-works"){
    requestAnimationFrame(()=>document.getElementById(u.pathname.slice(1))?.scrollIntoView({behavior:"smooth",block:"start"}))
  }else window.scrollTo({top:0,behavior:"instant"});
 };
 useEffect(()=>{if(path==="/features"||path==="/how-it-works"){requestAnimationFrame(()=>document.getElementById(path.slice(1))?.scrollIntoView({behavior:"smooth",block:"start"}))}},[path]);
 const refresh=async()=>{const me=await getMe();setAccount(me);return me};
 const toggle=()=>{setTheme(old=>{const next=old==="dark"?"light":"dark";localStorage.setItem("wecommander-theme",next);return next})};
 const logout=async()=>{try{await api("/api/auth/logout",{method:"POST"})}catch{}setAccount(null);navigate("/login")};
 const globalHeader=!["/dashboard","/account","/billing","/devices","/terminal","/files","/tasks","/mcp","/usage"].includes(path);
 return <div className="app-shell">
  {globalHeader&&<header className="site-header"><div className="container-w">
  <Brand onClick={()=>navigate("/")}/>
  <nav className="site-nav" aria-label="Ana gezinme">
   <NavLink to="/features" nav={navigate} className="hide-sm">Özellikler</NavLink>
   <NavLink to="/how-it-works" nav={navigate} className="hide-sm">Nasıl çalışır?</NavLink>
   <NavLink to="/pricing" nav={navigate}>Fiyatlandırma</NavLink>
  </nav>
  <div className="nav-actions">
   <ThemeToggle theme={theme} onToggle={toggle}/>
   <Button size="sm" variant="ghost" className="hide-sm" onClick={()=>navigate(account?"/dashboard":"/login")}>{account?"Panelim":"Giriş Yap"}</Button>
   <Button size="sm" className="wc-nav-install" onClick={()=>navigate("/install")}><Command className="size-4" aria-hidden="true"/> Install <ArrowUpRight className="size-4" aria-hidden="true"/></Button>
   <button type="button" aria-label="Menü" aria-expanded={mobile} className="mobile-menu" onClick={()=>setMobile(x=>!x)}>{mobile?<X/>:<Menu/>}</button>
  </div></div>
  {mobile&&<nav className="wc-mobile-nav" aria-label="Mobil gezinme">
   <NavLink to="/features" nav={navigate}>Özellikler</NavLink>
   <NavLink to="/how-it-works" nav={navigate}>Nasıl çalışır?</NavLink>
   <NavLink to="/pricing" nav={navigate}>Fiyatlandırma</NavLink>
   <NavLink to={account?"/dashboard":"/login"} nav={navigate}>{account?"Panelim":"Giriş Yap"}</NavLink>
   <NavLink to="/install" nav={navigate}>Install <ArrowUpRight size={15}/></NavLink>
  </nav>}
 </header>}
   {["/","/features","/how-it-works"].includes(path)&&<Landing nav={navigate} pricing={pricing} signupEnabled={signupEnabled}/>}
  {["/login","/register","/forgot-password","/reset-password","/verify"].includes(path)&&<AuthPage path={path} nav={navigate} refresh={refresh} pricing={pricing} signupEnabled={signupEnabled}/>}
  {path==="/install"&&<InstallPage nav={navigate}/>}
  {path==="/pricing"&&<PlansPage nav={navigate} pricing={pricing} account={account} signupEnabled={signupEnabled}/>}
  {path==="/checkout"&&<PlansPage nav={navigate} pricing={pricing} account={account} signupEnabled={signupEnabled} checkoutMode theme={theme}/>}
  {path==="/dashboard"&&<DashboardPage nav={navigate} path={path} account={account} checking={checking} refresh={refresh} logout={logout} theme={theme} toggle={toggle}/>}
  {path==="/billing"&&<BillingPage nav={navigate} account={account} checking={checking} theme={theme} toggle={toggle} logout={logout} pricing={pricing}/>}
  {path==="/account"&&<AccountPage nav={navigate} account={account} checking={checking} refresh={refresh} logout={logout} theme={theme} toggle={toggle}/>} 
  {path==="/devices"&&<DevicesPage nav={navigate} account={account} checking={checking} theme={theme} toggle={toggle} logout={logout}/>}
  {["/terminal","/files","/tasks","/mcp"].includes(path)&&<WorkspacePage nav={navigate} path={path.slice(1) as "terminal"|"files"|"tasks"|"mcp"} account={account} checking={checking} theme={theme} toggle={toggle} logout={logout}/>}
  {path==="/usage"&&<UsagePage nav={navigate} account={account} checking={checking} theme={theme} toggle={toggle} logout={logout}/>}

  {path==="/privacy"&&<div className="container-w section-modern"><Badge><ShieldCheck size={14}/> Gizlilik</Badge><h1 className="h2 mt-6">Gizlilik</h1><p className="muted mt-6 max-w-2xl">Hesap oturumları güvenli HttpOnly çerezleriyle korunur. Ödeme verileri WECOMMANDER sunucularında saklanmaz; ödeme Paddle tarafından işlenir. Ayrıntılı gizlilik koşulları yayımlanana kadar veri işleme taahhütleri hakkında destek ekibiyle iletişime geçebilirsiniz.</p></div>}
  {path==="/terms"&&<div className="container-w section-modern"><Badge><Command size={14}/> Koşullar</Badge><h1 className="h2 mt-6">Kullanım koşulları</h1><p className="muted mt-6 max-w-2xl">Hizmeti kullanırken yalnızca erişim yetkiniz olan cihazları bağlayın. Abonelik ve faturalama işlemleri Paddle üzerinden yürütülür. Sözleşme metninin tamamı henüz yayımlanmadıysa ödeme etkinleştirilmeden önce sözleşme ve iade koşulları hazırlanmalıdır.</p></div>}
 </div>;
}
