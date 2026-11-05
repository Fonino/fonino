export const metadata = { title: "AgentPhone" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, fontFamily: "-apple-system, system-ui, sans-serif", background: "#f5f5f7", color: "#111" }}>
        {children}
      </body>
    </html>
  );
}
