import { redirect } from 'next/navigation';

export default async function Home({ searchParams }: { searchParams: Promise<{ [key: string]: string | string[] | undefined }> }) {
  const params = await searchParams;
  if (params.code || params.error) {
    const qs = new URLSearchParams(params as Record<string, string>).toString();
    redirect(`/auth/callback?${qs}`);
  }
  redirect('/dashboard');
}