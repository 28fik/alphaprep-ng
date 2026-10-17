import { Route, Routes } from "react-router-dom";
import Layout from "./components/Layout";
import AdminShell from "./admin/AdminShell";
import Audit from "./admin/Audit";
import { ExamDetail, ExamList } from "./admin/Exams";
import Import from "./admin/Import";
import Overview from "./admin/Overview";
import Participants from "./admin/Participants";
import Questions from "./admin/Questions";
import Reports from "./admin/Reports";
import Security from "./admin/Security";
import Settings from "./admin/Settings";
import AdminLogin from "./pages/AdminLogin";
import AdminSetup from "./pages/AdminSetup";
import Continue from "./pages/Continue";
import Corrections from "./pages/Corrections";
import Exam from "./pages/Exam";
import Leaderboard from "./pages/Leaderboard";
import Result from "./pages/Result";
import Home from "./pages/Home";
import NotFound from "./pages/NotFound";
import Register from "./pages/Register";
import Start from "./pages/Start";

export default function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Home />} />
        <Route path="start" element={<Start />} />
        <Route path="register" element={<Register />} />
        <Route path="continue" element={<Continue />} />
        <Route path="exam" element={<Exam />} />
        <Route path="result" element={<Result />} />
        <Route path="corrections" element={<Corrections />} />
        <Route path="leaderboard" element={<Leaderboard />} />
        <Route path="*" element={<NotFound />} />
      </Route>
      {/* Admin area is separate from the public layout. Every real check happens on the server. */}
      <Route path="admin/login" element={<AdminLogin />} />
      <Route path="admin/setup" element={<AdminSetup />} />
      <Route path="admin" element={<AdminShell />}>
        <Route index element={<Overview />} />
        <Route path="exams" element={<ExamList />} />
        <Route path="exams/:id" element={<ExamDetail />} />
        <Route path="questions" element={<Questions />} />
        <Route path="import" element={<Import />} />
        <Route path="participants" element={<Participants />} />
        <Route path="reports" element={<Reports />} />
        <Route path="settings" element={<Settings />} />
        <Route path="audit" element={<Audit />} />
        <Route path="security" element={<Security />} />
      </Route>
    </Routes>
  );
}
