import { redirect } from "next/navigation";

// Entry point: send everyone to the data path. Unauthenticated users are bounced to /login by
// the middleware (and the /facts server component re-checks).
export default function Home() {
  redirect("/facts");
}
