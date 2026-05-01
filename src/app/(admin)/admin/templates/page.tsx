import TemplateManager from "@/components/admin/TemplateManager";
import { auth } from "@/auth";
import { redirect } from "next/navigation";

export default async function AdminTemplatesPage() {
    const session = await auth();
    if (!session?.user || session.user.role !== "ADMIN") {
        redirect("/dashboard");
    }

    return (
        <div className="max-w-5xl mx-auto px-4 py-8">
            <TemplateManager />
        </div>
    );
}
