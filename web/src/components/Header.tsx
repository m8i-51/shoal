import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import i18n from "../i18n/index";

export function Header() {
  const { t } = useTranslation();
  const navigate = useNavigate();

  const toggleLang = () => {
    const next = i18n.language === "ja" ? "en" : "ja";
    i18n.changeLanguage(next);
    localStorage.setItem("shoal-lang", next);
  };

  return (
    <header style={styles.header}>
      <button onClick={() => navigate("/")} style={styles.titleBtn}>
        {t("header.title")}
      </button>
      <nav style={styles.nav}>
        <button onClick={() => navigate("/hall")} style={styles.navLink}>
          {t("hall.navLink")}
        </button>
      </nav>
      <button onClick={toggleLang} style={styles.langBtn}>
        {i18n.language === "ja" ? "EN" : "JA"}
      </button>
    </header>
  );
}

const styles = {
  header: {
    background: "#1e293b",
    color: "#f8fafc",
    padding: "0 2rem",
    height: "52px",
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    position: "sticky" as const,
    top: 0,
    zIndex: 100,
  },
  titleBtn: {
    background: "transparent",
    border: "none",
    color: "#f8fafc",
    fontSize: "1rem",
    fontWeight: 700,
    letterSpacing: "0.04em",
    cursor: "pointer",
    padding: 0,
  },
  nav: {
    display: "flex",
    gap: "0.25rem",
    flex: 1,
    paddingLeft: "1.5rem",
  },
  navLink: {
    background: "transparent",
    border: "none",
    color: "#94a3b8",
    fontSize: "0.8rem",
    fontWeight: 600,
    cursor: "pointer",
    padding: "4px 8px",
    borderRadius: "6px",
    letterSpacing: "0.03em",
  },
  langBtn: {
    background: "transparent",
    border: "1px solid #475569",
    color: "#94a3b8",
    borderRadius: "6px",
    padding: "4px 10px",
    fontSize: "0.75rem",
    fontWeight: 600,
    letterSpacing: "0.05em",
  },
} as const;
