# Day Zombi Survival — Loja Oficial

Loja oficial em Node.js + Express, Firebase Authentication/Realtime Database e Mercado Pago Payment Brick.

## Deploy no Render já existente

Esta versão foi preparada para substituir os arquivos do repositório atual e usar o mesmo serviço do Render que já está configurado.

Ela continua usando as variáveis que já existem no serviço:

```text
FIREBASE_DATABASE_URL
FIREBASE_SERVICE_ACCOUNT_JSON
GAME_DOWNLOAD_URL
MP_ACCESS_TOKEN
MP_PUBLIC_KEY
MP_WEBHOOK_SECRET
NODE_VERSION
PUBLIC_URL
```

Não é necessário criar novas variáveis para o sistema de venda de chave. A configuração Web pública do Firebase tem os mesmos valores de fallback usados pela loja anterior.

O arquivo `.env` não deve ser enviado ao GitHub. O Render lê os segredos diretamente das Environment Variables já configuradas.

## Sistemas mantidos

- Login Google/Firebase.
- Nick único em `LOGINS_REGISTRADOS`.
- Saldo de Títulos em `LOGINS_REGISTRADOS/USUARIOS/<firebaseUid>/Dados/Titulos`.
- Pacotes normais de Títulos.
- Várias promoções temporárias de Títulos.
- Compra única por conta para cada promoção de Títulos.
- PIX e cartão via Mercado Pago.
- Webhook e consulta de pagamento.
- Histórico de compras.
- Crédito/estorno idempotente.
- Layout mobile.

## Venda dinâmica de chave

A venda de chave não fica fixa na loja. Ela só aparece quando o painel local publica uma oferta em:

```text
LojaDayZombiOficial/VendaChave
```

A oferta pode ser:

- promocional, com duração em horas, dias, semanas ou meses; ou
- normal, sem prazo, ficando ativa até ser removida no painel.

Quando não existe uma venda ativa, a interface da loja não mostra o banner, o modal ou qualquer oferta de compra de chave.

Quando existe uma venda ativa, aparece o banner de chave acima dos pacotes de Títulos. O preço real é consultado pelo backend no Firebase; o navegador não decide o valor.

Após um pagamento aprovado, a chave é gerada automaticamente e vinculada à conta Firebase do comprador. Uma conta que já possui acesso ativo não consegue comprar outra chave.

## Compatibilidade com o sistema antigo de chaves

O armazenamento antigo foi preservado para não quebrar chaves já existentes:

```text
LojaDayZombi/
  Usuarios/<firebaseUid>/AcessoTeste
  Chaves de Acessos/<chave>
  PagamentosProcessados/<paymentId>
```

O endpoint `/api/ativar-chave` continua usando esse mesmo formato. A chave continua no padrão:

```text
CHAVE-PLAYER-TESTE-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX
```

A página da conta usa `/api/meu-acesso` para consultar a chave, o link do Telegram e `GAME_DOWNLOAD_URL`.

## Promoções de Títulos

As promoções ficam em:

```text
LojaDayZombiOficial/Promocoes/<id-da-promocao>
```

Pacotes normais e promoções continuam separados nas abas da loja. Promoções expiradas deixam de aparecer automaticamente.

## Rodar/verificar

```bash
npm install
npm run check
npm start
```

No Render, mantenha o mesmo Build Command e Start Command já usados pelo serviço (`npm install` / `npm start`, caso sejam os atuais).

## Segurança

Nunca coloque `MP_ACCESS_TOKEN`, `MP_WEBHOOK_SECRET` ou a service account do Firebase dentro de `public/` ou no repositório. O pacote destinado ao GitHub não inclui `.env`.
