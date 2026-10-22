export default function Loading() {
  return (
    <div className="flex min-h-[60vh] items-center justify-center">
      <div className="flex items-center gap-3 rounded-lg border border-line bg-panel px-4 py-3 text-xs text-muted">
        <span className="pulse-dot size-2 rounded-full bg-accent" />
        正在整理内阁…
      </div>
    </div>
  );
}
