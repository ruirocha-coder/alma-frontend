export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="pt">
      <body style={{ background: "#0b0b0b", color: "#fff", fontFamily: "system-ui" }}>
        {children}
      </body>
    </html>
  );
}
