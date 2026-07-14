/**
 * ChatBubble — Message in a chat interface.
 *
 * Props:
 *   message   — string
 *   sender    — { name, avatar?, initials? }
 *   timestamp — string
 *   position  — 'left' | 'right'
 *   status    — 'sent'|'delivered'|'read' (right only)
 *   type      — 'text'|'image'|'file'
 *   imageUrl  — string (when type='image')
 *   fileName  — string (when type='file')
 *   reactions — [{ emoji, count }]
 */
import Avatar from "./Avatar";

const STATUS_ICONS = {
    sent: "✓",
    delivered: "✓✓",
    read: <span className="text-(--blue-foreground)">✓✓</span>,
};

export function ChatBubble({ message, sender, timestamp, position = "left", status, type = "text", imageUrl, fileName, reactions = [] }) {
    const isRight = position === "right";

    return (
        <div className={`flex items-end gap-2 font-aumovio ${isRight ? "flex-row-reverse" : "flex-row"}`}>
            {!isRight && <Avatar name={sender?.name} src={sender?.avatar} size="sm" />}
            <div className={`max-w-xs md:max-w-sm lg:max-w-md ${isRight ? "items-end" : "items-start"} flex flex-col gap-1`}>
                {!isRight && sender?.name && <span className="px-1 text-xs text-grey-500 font-aumovio-bold">{sender.name}</span>}
                <div
                    className={`relative rounded-2xl px-4 py-2.5 text-sm leading-relaxed
          ${isRight ? "bg-orange-400 text-(--on-accent-text) rounded-br-sm" : "bg-grey-100 dark:bg-(--bg-surface-3) text-black/85 dark:text-white/85 rounded-bl-sm"}`}
                >
                    {type === "image" && imageUrl && <img src={imageUrl} alt="Shared" className="max-w-full mb-1 rounded-lg" />}
                    {type === "file" && (
                        <div className="flex items-center gap-2 text-xs">
                            <span className="text-2xl">📎</span>
                            <span className="underline">{fileName}</span>
                        </div>
                    )}
                    {message && <p>{message}</p>}
                </div>
                {reactions.length > 0 && (
                    <div className={`flex gap-1 flex-wrap ${isRight ? "justify-end" : ""}`}>
                        {reactions.map((r, i) => (
                            <span
                                key={i}
                                className="text-xs text-black/80 dark:text-white/80 bg-white dark:bg-(--bg-surface-3) border border-grey-200
                dark:border-grey-600 rounded-full px-1.5 py-0.5 shadow-sm dark:shadow-black/30"
                            >
                                {r.emoji} {r.count}
                            </span>
                        ))}
                    </div>
                )}
                <div className={`flex items-center gap-1 text-xs text-grey-400 ${isRight ? "flex-row-reverse" : ""}`}>
                    <span>{timestamp}</span>
                    {isRight && status && <span>{STATUS_ICONS[status] ?? STATUS_ICONS.sent}</span>}
                </div>
            </div>
        </div>
    );
}

export default ChatBubble;
