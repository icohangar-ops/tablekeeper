import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Tablekeeper — reservations that cannot double-book",
  description:
    "Clean-room OpenTable clone for Dark Factory: a partial EXCLUDE constraint makes double-booking physically impossible. Built by a band of coding agents, gated by ShipScore.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <header className="site">
          <div className="wrap">
            <div className="brand">
              🍽️ Table<span>keeper</span>
            </div>
            <nav>
              <a href="#invariant">The invariant</a>
              <a href="#api">API</a>
              <a href="/api/health">Health</a>
              <a href="/api/audit">Audit log</a>
            </nav>
          </div>
        </header>
        <main className="wrap">{children}</main>
        <footer className="site">
          <div className="wrap">
            Dark Factory — WeAreDevelopers × BAND (lablab.ai) · built by a band
            of coding agents · every PR gated by ShipScore
          </div>
        </footer>
      </body>
    </html>
  );
}
