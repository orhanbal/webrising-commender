/**
 * The product's single icon set: Vuesax / Iconsax (MIT). The artwork comes from the
 * iconsax-reactjs package via scripts/generate-icons.mjs (Linear and Bold only).
 *
 * Style rule: Linear by default, Bold when the icon marks a selected or active
 * state (current nav item, selected tab, pressed toggle, chosen option). Use
 * <Icon icon={X} active={isActive}/> or variant={iconVariant(isActive)} for those.
 *
 * Pages import icons from here, never from the package directly, so the whole UI
 * maps every concept to one Iconsax glyph. The names are the app's own (they
 * predate the switch); the right-hand side is the Iconsax icon each one renders.
 */
import * as React from "react";
import {
  Activity, Add, ArrowDown2, ArrowLeft, ArrowLeft2, ArrowRight, ArrowRight2, ArrowUp, Brodcast, Building, Calendar, Calendar1,
  Card, Category, Chart21, ClipboardText, ClipboardTick, Clock, CloseCircle, Code, Code1, Command, Copy, Cpu, Data, DocumentDownload,
  Document, DocumentText, Devices, Driver, Driver2, Edit2, Electricity, ExportSquare, Eye, EyeSlash, Flash, Folder, FolderAdd, FolderOpen,
  Gallery, GalleryAdd, Global, HamburgerMenu, Hierarchy, Import, InfoCircle, Judge, Key, Lock, Logout, MagicStar, MessageText, Monitor,
  Moon, More, MouseCircle, Notification, Play, Profile2User, ReceiptText, Refresh2, SearchNormal1, Setting4, ShieldSearch, ShieldSecurity,
  ShieldTick, Sms, SmsEdit, SmsNotification, Stop, Sun1, TaskSquare, TickCircle, TickSquare, Trash, TrendUp, UserAdd, UserMinus, UserTick,
  VolumeHigh, Warning2, Wifi, CloudCross,
} from "./iconsax";
import type { IconComponent, IconProps, IconVariant } from "./iconsax-base";

export type { IconComponent, IconProps, IconVariant };
/** Linear normally, Bold for the selected / active / current item. */
export const iconVariant = (active?: boolean): IconVariant => (active ? "Bold" : "Linear");

/** Renders `icon` in the house style; `active` switches it to the Bold variant. */
export function Icon({ icon: C, active, ...props }: IconProps & { icon: IconComponent; active?: boolean }) {
  return <C variant={iconVariant(active)} {...props} />;
}

/**
 * Iconsax has no bare "x" or diagonal arrow, so these turn its own plus and up
 * arrow by 45°. Their Bold variants are filled squares, so they stay Linear.
 */
function turned(Base: IconComponent, name: string): IconComponent {
  const Turned = React.forwardRef<SVGSVGElement, IconProps>(({ style, variant: _variant, ...props }, ref) =>
    <Base {...props} ref={ref} variant="Linear" style={{ transform: "rotate(45deg)", ...style }} />);
  Turned.displayName = name;
  return Turned;
}
const Close = turned(Add, "Close");
const ArrowUpRightTurned = turned(ArrowUp, "ArrowUpRight");

// Loader2: Iconsax has no loader glyph; its circular refresh arrow spins instead.
export {
  // status
  Activity as Activity, Warning2 as AlertTriangle, InfoCircle as Info, TickCircle as Check, TickSquare as CheckCheck,
  TickCircle as CheckCircle2, CloseCircle as XCircle, Close as X, Refresh2 as Loader2,
  // arrows & chevrons
  ArrowLeft as ArrowLeft, ArrowRight as ArrowRight, ArrowRight as MoveRight, ArrowUp as ArrowUp, ArrowUpRightTurned as ArrowUpRight,
  ArrowDown2 as ChevronDown, ArrowLeft2 as ChevronLeft, ArrowRight2 as ChevronRight, ExportSquare as ExternalLink,
  // actions
  Add as Plus, Copy as Copy, Trash as Trash2, Edit2 as Pencil, Play as Play, Stop as Square, Refresh2 as RefreshCw,
  DocumentDownload as Save, Import as Download, SearchNormal1 as Search, Logout as LogOut, More as MoreHorizontal,
  MouseCircle as MousePointerClick, HamburgerMenu as Menu, Moon as Moon, Sun1 as Sun, Eye as Eye, EyeSlash as EyeOff,
  // navigation & sections
  Category as LayoutDashboard, Hierarchy as Workflow, Command as Command, Setting4 as Settings2, Notification as Bell,
  ClipboardText as ScrollText, ClipboardTick as ClipboardCheck, TaskSquare as ListChecks, Chart21 as BarChart3, TrendUp as TrendingUp,
  // devices & infrastructure
  Monitor as Monitor, Devices as Laptop, Code1 as TerminalSquare, Code as Code2, Driver as Server, Driver2 as HardDrive,
  Data as Database, Brodcast as RadioTower, Wifi as Wifi, CloudCross as WifiOff, Electricity as Plug, Electricity as Plug2,
  Electricity as Usb, Cpu as Bot, Global as Globe, Global as Globe2,
  // security
  ShieldTick as ShieldCheck, ShieldSecurity as ShieldAlert, ShieldSearch as ShieldQuestion, Lock as LockKeyhole, Key as KeyRound,
  // time
  Clock as Clock3, Clock as History, Calendar as CalendarClock, Calendar1 as CalendarDays,
  // files & content
  Document as File, DocumentText as FileText, Folder as Folder, FolderOpen as FolderOpen, FolderAdd as FolderPlus,
  Gallery as Image, GalleryAdd as ImagePlus, ReceiptText as ReceiptText, MessageText as MessageSquareText,
  // people & communication
  Profile2User as Users, UserAdd as UserPlus, UserMinus as UserMinus, UserTick as UserCheck, Building as Building2,
  Sms as Mail, SmsNotification as MailCheck, SmsEdit as MailPlus, Sms as MailX, VolumeHigh as Megaphone,
  // money & misc
  Card as CreditCard, Judge as Scale, MagicStar as Sparkles, Flash as Zap,
};
