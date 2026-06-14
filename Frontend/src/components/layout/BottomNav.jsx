/**
 * BottomNav — Mobile fixed bottom navigation bar.
 *
 * Props:
 *   items — [{ id, label, icon, href, badge? }]
 *   active — active item id
 *   onChange — (id) => void
 *   variant — 'default' | 'pill' | 'floating'
 */
import { NavLink } from "react-router-dom";
import { TRANSITION_COLORS } from "../../assets/styles/pre-set-styles";

export function BottomNav({ items = [], variant = "default" }) {
    const base = {
        default: "fixed bottom-0 left-0 right-0 z-50 bg-(--surface-2) border-t border-(--border-elevation) px-2 py-1 flex justify-around",
        pill: "fixed bottom-4 left-1/2 -translate-x-1/2 z-50 bg-(--surface-2) shadow-2xl rounded-full border border-(--border-elevation) px-4 py-2 flex gap-1",
        floating: "fixed bottom-6 left-4 right-4 z-50 bg-(--surface-2)/90 backdrop-blur-md shadow-2xl rounded-2xl border border-(--border-elevation) px-3 py-2 flex justify-around",
    };

    return (
        <nav className={`font-aumovio ${base[variant]}`} aria-label="Bottom navigation">
            {items.map((item) => (
                <NavLink key={item.id} to={item.href}>
                    {({ isActive }) => (
                        <div
                            className={`flex flex-col items-center gap-0.5 px-3 py-1 rounded-xl
              ${TRANSITION_COLORS} cursor-pointer relative
              ${isActive ? "text-(--nav-active-text)" : "text-grey-400 hover:text-grey-600 dark:hover:text-grey-300"}`}
                        >
                            <div className="relative">
                                <item.icon className="w-5 h-5" />
                                {item.badge && (
                                    <span
                                        className="absolute -top-1 -right-1 w-4 h-4 bg-danger-400 text-white
                    text-[10px] rounded-full flex items-center justify-center font-aumovio-bold"
                                    >
                                        {item.badge}
                                    </span>
                                )}
                            </div>
                            <span className="text-xs">{item.label}</span>
                            {isActive && <span className="absolute bottom-0 w-1 h-1 -translate-x-1/2 bg-(--accent) rounded-full left-1/2" />}
                        </div>
                    )}
                </NavLink>
            ))}
        </nav>
    );
}

export default BottomNav;
