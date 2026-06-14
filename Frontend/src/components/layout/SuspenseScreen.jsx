const GRADIENT = "linear-gradient(to right, #FF4208, #ff850a, #a08ae5)";

export default function SuspenseScreen() {
    return (
        <div className="flex min-h-screen items-center justify-center flex-col gap-6" style={{ background: "linear-gradient(135deg, #0f0c1a 0%, #1a1030 50%, #0d0d14 100%)" }}>
            <h1 className="text-3xl font-extrabold tracking-widest bg-clip-text text-transparent" style={{ backgroundImage: GRADIENT, WebkitBackgroundClip: "text" }}>
                PAUNLAGUI
            </h1>

            <div className="flex gap-2">
                {[0, 1, 2].map((i) => (
                    <div key={i} className="h-1.5 w-1.5 rounded-full animate-pulse" style={{ background: GRADIENT, animationDelay: `${i * 0.2}s` }} />
                ))}
            </div>
        </div>
    );
}
