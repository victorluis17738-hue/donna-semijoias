import {
  Shield,
  ClipboardList,
  FileCheck,
  ClipboardPen,
  Package,
  User,
} from "lucide-react";
import { NavLink } from "react-router-dom";

export default function Sidebar() {
  return (
    <aside className="sidebar">
      <div className="brand-box">
        <div className="brand-icon">
          <Shield size={28} />
        </div>
        <h1>Avaliação e Solicitação de EPI</h1>
        <p>
          Sistema interno para avaliação, solicitação e acompanhamento de
          equipamentos de segurança.
        </p>
      </div>

      <nav className="menu">
        <NavLink to="/" className={({ isActive }) => `menu-item ${isActive ? "active" : ""}`}>
          <ClipboardList size={18} />
          <span>Dashboard</span>
        </NavLink>

        <NavLink
          to="/avaliar-epi"
          className={({ isActive }) => `menu-item ${isActive ? "active" : ""}`}
        >
          <FileCheck size={18} />
          <span>Avaliar EPI</span>
        </NavLink>

        <NavLink
          to="/solicitar-epi"
          className={({ isActive }) => `menu-item ${isActive ? "active" : ""}`}
        >
          <ClipboardPen size={18} />
          <span>Solicitar EPI</span>
        </NavLink>

        <NavLink
          to="/minhas-solicitacoes"
          className={({ isActive }) => `menu-item ${isActive ? "active" : ""}`}
        >
          <Package size={18} />
          <span>Minhas solicitações</span>
        </NavLink>

        <NavLink
          to="/perfil"
          className={({ isActive }) => `menu-item ${isActive ? "active" : ""}`}
        >
          <User size={18} />
          <span>Perfil</span>
        </NavLink>
      </nav>

      <div className="info-cards">
        <div className="info-card">
          <strong>Fluxo do sistema</strong>
          <p>Avalie o EPI atual antes de solicitar uma nova troca.</p>
        </div>

        <div className="info-card">
          <strong>Organização</strong>
          <p>Acompanhe solicitações, aprovações e entregas em um só lugar.</p>
        </div>
      </div>
    </aside>
  );
}