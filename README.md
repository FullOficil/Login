# DayZombi Login — Google, Firebase e retorno ao aplicativo

Este projeto cria uma página chamada **Login** para ser publicada no Render.

## Fluxo implementado

1. O jogador toca em **Continuar com Google**.
2. O Firebase Authentication realiza o login.
3. O servidor verifica o ID token do Firebase.
4. O servidor procura a conta em:

```text
LOGINS_REGISTRADOS
└── USUARIOS
    └── <firebaseUid>
```

5. Se a conta ainda não possuir Nick, o site mostra um painel para escolher um Nick.
6. O Nick é reservado por transação para impedir duplicidade.
7. O servidor cria um código temporário de cinco minutos.
8. O navegador tenta abrir o aplicativo Android `com.VerteSZ.DayZombi` usando:

```text
dayzombi://login?codigo=CODIGO_TEMPORARIO
```

O ID token real do Firebase não é colocado no link.

## Estrutura criada no Realtime Database

```text
LOGINS_REGISTRADOS
├── USUARIOS
│   └── <firebaseUid>
│       ├── Dados
│       └── Eventos
├── NICKS
│   └── <nickEmMinusculo>
└── UID_PARA_NICK
    └── <firebaseUid>

LOGIN_APP
└── CODIGOS
    └── <sha256DoCodigoTemporario>
```

## Arquivos

```text
server.js
package.json
render.yaml
.env.example
public/
├── index.html
├── styles.css
└── app.js
```

## Configuração no Firebase

No Firebase Console:

1. Abra **Authentication**.
2. Ative o provedor **Google**.
3. Em **Domínios autorizados**, adicione o domínio que o Render fornecer, por exemplo:

```text
dayzombi-login.onrender.com
```

## Variáveis no Render

Use as variáveis do arquivo `.env.example`.

A mais importante para o servidor é:

```text
FIREBASE_SERVICE_ACCOUNT_JSON
```

Ela deve conter o JSON da conta de serviço do Firebase. Nunca publique esse JSON no GitHub.

## Render

```text
Build Command: npm ci
Start Command: npm start
Node: 22
```

## Parte que será feita na Unity depois

O site já tenta abrir:

```text
dayzombi://login?codigo=...
```

Para o Android realmente abrir o DayZombi, o projeto Unity precisará registrar o esquema `dayzombi` no AndroidManifest. Depois, a Unity pegará o parâmetro `codigo` e enviará para:

```http
POST /api/trocar-codigo-login-app
Content-Type: application/json

{
  "codigo": "CODIGO_RECEBIDO"
}
```

Por enquanto, o site e o servidor já deixam esse próximo passo preparado.
