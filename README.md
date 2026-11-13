# Paulinho Serviços Gerais – mapa de obras

Site estático (um único `index.html`) com mapa de obras, orçamento por WhatsApp e área administrativa.

## Supabase (já configurado)
- Tabela `obras` com RLS (migrations em `supabase/migrations`).
- Bucket público `obras-fotos` (só imagens JPG/PNG/WebP, até 5 MB).
- Leitura pública pela URL; envio, alteração e exclusão só para usuário com `role = admin`.
- A chave usada no site é a *publishable* (pública por design). Nunca coloque a `service_role` no projeto.

### Criar o administrador
1. Supabase > Authentication > Users > Add user (e-mail e senha, marque Auto Confirm).
2. Rode `supabase/promover-admin.sql` no SQL Editor com o seu e-mail.
3. Recomendado: Authentication > Sign In / Providers > desative "Allow new users to sign up".

## Publicar
```bash
git init && git add . && git commit -m "Primeira versão"
git branch -M main
git remote add origin https://github.com/SEU_USUARIO/SEU_REPOSITORIO.git
git push -u origin main
```
Na Vercel: Add New > Project > importar o repositório (Framework: Other, sem build command, sem output directory).

## Dados das obras
As obras ficam na tabela `public.obras` (Supabase): leitura pública para todos os visitantes; cadastro, edição e exclusão só pelo administrador. Para apagar ou corrigir uma obra, use Table Editor no painel do Supabase.
