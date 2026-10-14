import { Route, Routes } from "react-router-dom";
import Layout from "./components/Layout";
import AdminHome from "./pages/AdminHome";
import AdminLogin from "./pages/AdminLogin";
import AdminSetup from "./pages/AdminSetup";
import Continue from "./pages/Continue";
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
        <Route path="*" element={<NotFound />} />
      </Route>
      {/* Admin area is separate from the public layout. All real checks happen on the server. */}
      <Route path="admin" element={<AdminHome />} />
      <Route path="admin/login" element={<AdminLogin />} />
      <Route path="admin/setup" element={<AdminSetup />} />
    </Routes>
  );
}
