import { useTranslation } from "react-i18next";
import i18n from "../i18n/index";

export function Header() {
  const { t } = useTranslation();

  const toggleLang = () => {
    const next = i18n.language === "ja" ? "en" : "ja";
    i18n.changeLanguage(next);
    localStorage.setItem("shoal-lang", next);
  };

  return (
    <header style={styles.header}>
      <span style={styles.title}>{t("header.title")}</span>
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
  title: {
    fontSize: "1rem",
    fontWeight: 700,
    letterSpacing: "0.04em",
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
