/**
 * ProfileModal — Simple "Your Profile" modal with a LinkedIn-style header
 * banner and a large initials avatar (Microsoft Teams style).
 *
 * Built on top of the shared Modal component (portal, blur, Escape, scroll-lock
 * are all handled there). We pass no `title` so Modal skips its default header,
 * and we render the custom banner + avatar inside `children`.
 *
 * Props:
 *   open    — boolean
 *   onClose — () => void
 *   user    — decoded user object from AuthMiddleware
 *
 * The avatar circle colour is deterministic based on the user's name,
 * exactly matching the Avatar component used in Navbar / Sidebar.
 */
import { BuildingOffice2Icon, EnvelopeIcon, IdentificationIcon, ShieldCheckIcon, XMarkIcon } from "@heroicons/react/24/outline";

import headerImg from "../../assets/img/LinkedIn_Header_Employees_1584x396.png";
import { TRANSITION_COLORS } from "../../assets/styles/pre-set-styles";
import { Badge } from "../ui/Badge";
import { Modal } from "../ui/Modal";

/* ── Colour palette — must stay in sync with Avatar.jsx ────────────────── */
// All entries use palette-responsive CSS variable families so they shift
// when the user picks a different accent in Personalize.
const PALETTE = [
    { bg: "bg-orange-400", text: "text-white" },
    { bg: "bg-purple-400", text: "text-white" },
    { bg: "bg-blue-400", text: "text-white" },
    { bg: "bg-turquoise-500", text: "text-white" },
    { bg: "bg-yellow-600", text: "text-white" },
    { bg: "bg-orange-600", text: "text-white" },
    { bg: "bg-purple-600", text: "text-white" },
];

/** Deterministic colour from a name string (same hash as Avatar.jsx). */
function getColor(name = "") {
    const sum = [...name].reduce((acc, c) => acc + c.charCodeAt(0), 0);
    return PALETTE[sum % PALETTE.length];
}

/** Extract initials — same logic as Avatar.jsx. */
function getInitials(name = "") {
    const parts = name.trim().split(" ").filter(Boolean);
    if (!parts.length) return "?";
    return parts.length === 1 ? parts[0].slice(0, 2).toUpperCase() : (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/* ── Role helpers (mirrors Navbar.jsx) ─────────────────────────────────── */
function resolveRoleLabel(role) {
    if (role === "SUPER_ADMIN") return "Super ADMIN";
    if (role === "ADMIN") return "ADMIN";
    if (role === "VENDOR") return "Vendor";
    if (role === "ROBOT") return "Automation";
    return "USER";
}

function resolveRoleBadgeVariant(role) {
    if (role === "SUPER_ADMIN") return "purple";
    if (role === "ADMIN") return "orange";
    if (role === "VENDOR") return "cyan";
    if (role === "ROBOT") return "green";
    return "grey";
}

/* ── Component ─────────────────────────────────────────────────────────── */
export default function ProfileModal({ open, onClose, user }) {
    if (!user) return null;

    const fullName = `${user.firstName ?? ""} ${user.lastName ?? ""}`.trim();
    const initials = getInitials(fullName);
    const color = getColor(fullName);
    const roleLabel = resolveRoleLabel(user.role);
    const roleBadge = resolveRoleBadgeVariant(user.role);

    return (
        <Modal open={open} onClose={onClose} size="md">
            {/* ── Header banner ─────────────────────────────────── */}
            <div className="relative aspect-4/1 -mx-6 -mt-5">
                <img src={headerImg} alt="" className="w-full h-full object-cover" draggable={false} />
                {/* Gradient overlay for readability */}
                <div className="absolute inset-0 bg-linear-to-t from-black/30 to-transparent" />

                {/* Close button */}
                <button
                    onClick={onClose}
                    aria-label="Close"
                    className={`absolute top-3 right-3 flex items-center justify-center w-8 h-8
                        rounded-full bg-black/30 backdrop-blur-sm text-white/80
                        hover:bg-black/50 hover:text-white ${TRANSITION_COLORS}`}
                >
                    <XMarkIcon className="w-4 h-4" />
                </button>
            </div>

            {/* ── Avatar (overlapping the banner) ───────────────── */}
            <div className="flex left -mt-14 relative z-10">
                <div
                    className={`flex items-center justify-center w-24 h-24 rounded-full
                        ${color.bg} ${color.text}
                        text-3xl font-aumovio-bold
                        ring-4 ring-white dark:ring-(--bg-surface-2)
                        shadow-lg select-none`}
                >
                    {initials}
                </div>
            </div>

            {/* ── Profile info ──────────────────────────────────── */}
            <div className="pt-3 pb-1 text-center">
                {/* Name */}
                <h2 className="text-lg font-aumovio-bold text-black/85 dark:text-white/90 truncate text-left">{fullName || "—"}</h2>

                {/* Role badge */}
                <div className="mt-1.5 flex text-left">
                    <Badge variant={roleBadge} size="sm" pill>
                        {roleLabel}
                    </Badge>
                </div>

                {/* Divider */}
                <div className="my-4 h-px bg-grey-200 dark:bg-grey-700" />

                {/* Detail rows */}
                <div className="space-y-3 text-left text-sm text-grey-600 dark:text-grey-300">
                    {user.empId && <DetailRow icon={IdentificationIcon} label="Employee ID" value={user.empId} />}
                    {user.email && <DetailRow icon={EnvelopeIcon} label="Email" value={user.email} />}
                    {user.segmentDesc && <DetailRow icon={BuildingOffice2Icon} label="Division" value={user.segmentDesc} />}
                    {user.role && <DetailRow icon={ShieldCheckIcon} label="Role" value={roleLabel} />}
                </div>
            </div>
        </Modal>
    );
}

/**
 * DetailRow — single labelled info line inside the profile card.
 */
function DetailRow({ icon: Icon, label, value }) {
    return (
        <div className="flex items-start gap-3">
            <Icon className="w-4.5 h-4.5 mt-0.5 shrink-0 text-grey-400 dark:text-grey-500" />
            <div className="min-w-0">
                <p className="text-[11px] uppercase tracking-wider text-grey-400 dark:text-grey-500 font-aumovio-bold leading-none mb-0.5">{label}</p>
                <p className="truncate">{value}</p>
            </div>
        </div>
    );
}
