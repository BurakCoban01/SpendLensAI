import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: "#141414",
        paper: "#f6f7f9",
        steel: "#4b5563",
        signal: "#0f766e"
      }
    }
  },
  plugins: []
};

export default config;
