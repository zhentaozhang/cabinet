/** The brand mark: four squares that read as a cabinet at 28px. */
export function Mark() {
  return (
    <div className="grid size-7 grid-cols-2 gap-[3px] rounded-md border border-accent/40 bg-accent/10 p-[5px]">
      <span className="rounded-[2px] bg-accent" />
      <span className="rounded-[2px] bg-accent/50" />
      <span className="rounded-[2px] bg-accent/50" />
      <span className="rounded-[2px] bg-accent" />
    </div>
  );
}
