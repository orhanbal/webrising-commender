import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
export default defineConfig({ base:"/modern/", plugins:[react(),tailwindcss()], build:{outDir:"dist",emptyOutDir:true,assetsDir:"assets"},server:{proxy:{"/api":"http://localhost:8787","/webhooks":"http://localhost:8787"}} });
