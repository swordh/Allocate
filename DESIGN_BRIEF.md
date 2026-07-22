# Allocate – Design Brief

Detta dokument beskriver alla vyer och mail i Allocate som behöver design. För varje vy beskrivs syfte, innehåll, användaråtgärder och viktiga tillstånd. Inget om visuell design ingår.

*Senast avstämt mot koden: 22 juli 2026.*

---

## Roller & behörigheter

Allocate har tre användarroller:

- **Admin** – full tillgång, inklusive alla inställningar
- **Crew** – kan skapa och hantera bokningar
- **Viewer** – kan bara se bokningar, inte skapa

Det finns även en separat **Operator**-roll för intern administration av plattformen.

---

## Autentisering

### 1. Logga in

Sida där befintliga användare loggar in.

**Innehåll:**
- Fält för e-postadress
- Fält för lösenord
- Länk till registrering ("Skapa ett konto")

**Åtgärder:**
- Logga in med e-post och lösenord

**Tillstånd:**
- Laddar (inloggning pågår)
- Felmeddelande: ogiltiga uppgifter, för många försök

---

### 2. Skapa konto

Sida för att registrera sig. Har två flöden beroende på om man startar ett nytt företag eller accepterar en inbjudan.

**Innehåll:**
- Val: "Skapa ett nytt företag" eller "Jag har en inbjudningslänk"

**Flöde A – Nytt företag:**
- Fält: företagsnamn, tidszon (autodetekteras), namn, e-post, lösenord

**Flöde B – Acceptera inbjudan:**
- Fält: inbjudningskod/länk
- Sedan: namn och lösenord (e-post är låst till inbjudans e-post)

**Åtgärder:**
- Skapa konto
- Byta mellan de två flödena

**Tillstånd:**
- Validerar inbjudningskod
- Laddar (konto skapas)
- Felmeddelanden: e-post redan registrerad, för svagt lösenord, ogiltig/utgången inbjudan, inbjudan skickad till annan e-post

---

### 3. Verifiera e-post

Sida som visas efter registrering och vid inloggning med overifierad e-post.

**Innehåll:**
- Information om att ett verifieringsmail har skickats till användarens e-postadress
- Knapp: "Jag har verifierat, fortsätt"
- Knapp: "Skicka om mailet"

**Tillstånd:**
- Kontrollerar om e-post är verifierad
- Skickar om verifieringsmail
- Felmeddelande om något gick fel
- Vidarebefodrar automatiskt om e-posten verifieras medan sidan är öppen

---

### 4. Auth-länk (lösenordsåterställning / e-postverifiering / byte av e-post)

Sida som hanteras när användaren klickar en länk från ett mail. Länken pekar alltid på Allocates egen domän (`allocate.at/auth/action`) och bär en engångskod (`oobCode`) samt ett `mode` som avgör flödet.

**Innehåll beror på länktyp (`mode`):**

**E-postverifiering (`verifyEmail`):** Bekräftelsevy – användaren klickar för att verifiera, sedan vidarebefordras.

**Bekräfta ny e-postadress (`verifyAndChangeEmail`):** Bekräftelsevy för byte av inloggnings-e-post. Aktiveras från Inställningar – Konto och skickas till den nya adressen.

**Lösenordsåterställning (`resetPassword`):**
- Fält: nytt lösenord
- Knapp: "Spara nytt lösenord"

**Tillstånd:**
- Laddar (validerar länk)
- Bekräftelsevy (verifiering / byte av e-post)
- Formulär för nytt lösenord
- Bekräftelse: åtgärden är genomförd
- Fel: ogiltig eller utgången länk

---

## Bokningar

### 5. Bokningsvy – 4 veckor

Kalendervy som visar 28 dagar av bokningar.

**Innehåll:**
- Rutnät med 4 veckor
- Bokningar visas på respektive dag
- Navigation: byta 4-veckorsperiod

**Åtgärder:**
- Navigera till föregående/nästa period
- Klicka på en bokning för att se detaljer
- Skapa ny bokning

---

### 6. Bokningsvy – Vecka

Kalendervy för en enskild vecka.

**Innehåll:**
- 7-dagarsvy
- Bokningar med tidsluckor per dag
- Navigation: byta vecka

**Åtgärder:**
- Navigera till föregående/nästa vecka
- Klicka på en bokning för att se detaljer
- Skapa ny bokning

---

### 7. Bokningsvy – Månad

Kalendervy för en hel månad.

**Innehåll:**
- Månadsrutnät
- Bokningar markerade per dag
- Navigation: byta månad

**Åtgärder:**
- Navigera till föregående/nästa månad
- Klicka på en bokning för att se detaljer
- Skapa ny bokning

---

### 8. Bokningsvy – Lista

Tabellvy med alla bokningar.

**Innehåll:**
- Tabell med alla bokningar
- Kolumner: datum, utrustning, skapad av, status
- Klickbara rader

**Åtgärder:**
- Klicka på en bokning för att se detaljer
- Skapa ny bokning
- Sortera/filtrera (beroende på implementation)

---

### 9. Ny bokning

Formulär för att skapa en bokning. Uppbyggt i tre numrerade sektioner: **PROJECT**, **DATES** och **EQUIPMENT**.

**PROJECT:**
- Projektnamn (obligatoriskt)

**DATES:**
- Kalender för att välja datumintervall (upphämtning → återlämning)
- Datumavläsning märkt **PICKUP** och **RETURN**
- "Full day"-växel: boka hela dagen eller sätta specifika tider
- Om specifika tider: tidsväljare märkta **PICKUP TIME** och **RETURN TIME** (tidsluckor styrs av företagets preferens)

**EQUIPMENT:**
- Utrustning listad grupperad per kategori (från företagets inventarie)
- Antal per utrustningstyp, **eller** val av specifika enheter (units) per typ – flera enheter kan väljas per utrustning
- Live-tillgänglighet: konflikter mot valda datum kontrolleras i realtid och redan bokade enheter markeras

**Övriga fält:**
- Anteckningar (valfritt)

**Åtgärder:**
- Fylla i och skicka formuläret (kräver projektnamn, datum och minst en vald utrustning)
- Avbryta och återgå

**Tillstånd:**
- Validering av alla fält innan formuläret skickas
- Kontrollerar tillgänglighet / konflikter ("checking…")
- Ej tillgängligt för Viewer (omdirigeras)

---

### 10. Bokningsdetalj

Detaljsida för en enskild bokning. Visar information och tillgängliga åtgärder beroende på roll och bokningens status.

**Innehåll:**
- Datum och tider
- Utrustning med antal
- Skapad av
- Status (med statusmärke)
- Anteckningar

**Åtgärder (beroende på roll och status):**
- **Redigera** – ägare eller admin, när status är väntande eller bekräftad
- **Godkänn** – admin, när status är väntande
- **Avböj** – admin, när status är väntande
- **Avbryt** – ägare eller admin, när status är väntande eller bekräftad
- **Lämna ut (Check Out)** – admin, när status är bekräftad
- **Ta emot (Check In)** – admin, när status är utlämnad

**Statusar:**
- Väntande
- Bekräftad
- Utlämnad
- Återlämnad
- Avbruten
- Avböjd

---

## Utrustning

### 11. Utrustning

Sida för att hantera företagets utrustningsinventarie.

**Innehåll:**
- Lista av utrustningstyper, grupperade per kategori
- Per typ: namn, antal enheter, aktiv/inaktiv
- Per enhet: serienummer, anteckningar

**Åtgärder:**
- Skapa ny utrustningstyp
- Lägg till enheter till en typ
- Redigera utrustningstyp (namn, kategori)
- Inaktivera/aktivera utrustning
- Ta bort utrustning eller enskilda enheter
- Se och redigera enhetsdetaljer

**Tillstånd:**
- Modal/formulär för att lägga till/redigera
- Realtidsuppdateringar

---

## Inställningar

Inställningar har en navigering med flikar/undersidor. Admin-sidor är ej tillgängliga för Crew och Viewer.

### 12. Inställningar – Konto

Personliga inställningar för inloggad användare.

**Innehåll:**
- Namn (redigerbart)
- E-postadress (visas) med "Change Email →" som fäller ut ett inline-formulär för ny adress
- Byt lösenord (skickar en återställningslänk till den egna adressen)
- Standardvy för bokningar (lista/vecka/månad/4 veckor)

**Åtgärder:**
- Spara ändringar (namn, standardvy)
- Byt e-post: ange ny adress → ett bekräftelsemail skickas till den nya adressen (se mail 28)
- Byt lösenord: ett återställningsmail skickas till den egna adressen
- Exportera mina uppgifter (laddar ner JSON-fil)
- Logga ut
- Radera konto (kräver bekräftelse – användaren skriver in texten "DELETE")

**Tillstånd:**
- Sparar
- E-poständring skickad (väntar på bekräftelse via mail) / fel (t.ex. adress upptagen, utgången session)
- Återställningsmail för lösenord skickat
- Exporterar data
- Loggar ut
- Raderar konto (bekräftelsesteg)

---

### 13. Inställningar – Företag *(Admin)*

Inställningar för företaget.

**Innehåll:**
- Företagsnamn (redigerbart)
- Lista med utrustningskategorier
- Möjlighet att lägga till anpassade fält per kategori

**Åtgärder:**
- Ändra företagsnamn
- Lägg till kategori
- Redigera kategorinamn
- Ta bort kategori
- Konfigurera anpassade fält för kategori
- Spara

---

### 14. Inställningar – Team *(Admin)*

Hantera teammedlemmar.

**Innehåll:**
- Lista med befintliga medlemmar: namn, e-post, roll (Admin/Crew/Viewer), datum de gick med
- Formulär för att bjuda in ny medlem: e-post + roll

**Åtgärder:**
- Bjud in ny medlem
- Ändra en medlems roll
- Ta bort en medlem (kräver bekräftelse)

**Tillstånd:**
- Skickar inbjudan
- Bekräftelsedialog vid borttagning
- Felmeddelanden (t.ex. om användaren redan är medlem)

---

### 15. Inställningar – Preferenser *(Admin)*

Inställningar för hur bokningar fungerar.

**Innehåll:**
- Tidslucksinställning för bokningar (t.ex. 30 min, 1 timme)

**Åtgärder:**
- Ändra tidslucksstorlek
- Spara

---

### 16. Inställningar – Prenumeration *(Admin)*

Hantera prenumeration och fakturering.

**Planer:**
- **Starter** – 149 kr/mån (1490 kr/år). 25 utrustningar, 10 användare.
- **Basic** – 390 kr/mån (3900 kr/år). 100 utrustningar, 30 användare.

**Innehåll:**
- Nuvarande plan (planmärke)
- Status (aktiv, testperiod, förfallen, avslutad)
- Utrustningsgräns och användargräns
- Faktureringscykel och nästa förnyelsedatum
- Knapp: "Hantera" (öppnar Stripe-portal för betalning/avslut)
- Vid aktiv prenumeration: plankort för alla planer, med nuvarande markerad, och möjlighet att byta plan (uppgradera/nedgradera) direkt i appen med proportionerlig justering (proration)
- Om ingen aktiv prenumeration: planväljare + val av månads-/årsintervall för att teckna

**Åtgärder:**
- Öppna Stripe-faktureringsportal ("Hantera")
- Byt plan (uppgradera/nedgradera) i appen
- Starta ny prenumeration (månads- eller årsvis)

**Tillstånd:**
- Laddar (omdirigerar till Stripe)
- Felmeddelande

---

## Övriga sidor

### 17. Inbjudan – Acceptera

Sida som användare landar på via en inbjudningslänk.

**Innehåll:**
- Företagets namn
- Information om inbjudan
- CTA: "Logga in för att acceptera" och "Skapa ett konto"
- Om länken är ogiltig/utgången/redan använd: felmeddelande

**Tillstånd:**
- Ogiltig inbjudan
- Inbjudan redan accepterad
- Inbjudan återkallad
- Giltig inbjudan + ej inloggad: visar CTA
- Giltig inbjudan + inloggad: accepterar automatiskt och vidarebefordrar
- Accepterar (laddar)
- Felmeddelande (t.ex. e-post matchar inte)

---

### 18. Prenumerera

Sida för att välja och teckna en prenumeration, visas när företaget saknar aktiv prenumeration.

**Innehåll:**
- Tillgängliga planer med priser och funktioner: **Starter** (149 kr/mån · 1490 kr/år, 25 utrustningar/10 användare) och **Basic** (390 kr/mån · 3900 kr/år, 100 utrustningar/30 användare)
- Val av faktureringsintervall (månadsvis / årsvis)

**Åtgärder:**
- Välj plan och starta betalning via Stripe Checkout
- Länkar till användarvillkor och integritetspolicy

---

### 19. Integritetspolicy

Statisk sida med integritetspolicyn.

**Innehåll:**
- Senast uppdaterad: 27 april 2026
- Avsnitt: personuppgiftsansvarig, vad som samlas in, varför, tredjepartsprocessorer, datalagring, dina rättigheter, cookies, ändringar
- Kontaktuppgifter
- Länk till Inställningar – Konto (för dataexport)

---

### 20. Användarvillkor

Statisk sida med användarvillkoren.

**Innehåll:**
- Senast uppdaterad: 25 april 2026
- Avsnitt: tjänsten, kontoansvaret, tillåten användning, prenumeration och fakturering, data och integritet, tillgänglighet, ansvarsbegränsning, uppsägning, tillämplig lag
- Kontaktuppgifter
- Länk till integritetspolicyn

---

## Operator (intern administration)

Dessa sidor är enbart tillgängliga för Allocates interna operatörer.

### 21. Operator – Kundlista

Översikt över alla kundföretag.

**Innehåll:**
- Sökfält (filtrera på företagsnamn)
- Tabell med: företagsnamn, prenumerationsstatus, plan, period slutdatum, registreringsdatum, antal medlemmar

**Åtgärder:**
- Sök/filtrera på namn
- Klicka på ett företag för att se detaljer

---

### 22. Operator – Kunddetalj

Detaljsida för ett kundföretag.

**Innehåll (flikar):**

**Flik: Översikt**
- Företagsnamn, registreringsdatum
- Stripe-kund-ID
- Prenumerationsstatus, plan, perioddatum
- Antal medlemmar, bokningar, utrustning
- Datum för senaste bokning

**Flik: Anteckningar**
- Fritextfält för interna anteckningar om kunden (sparas automatiskt)

**Lista med teammedlemmar:**
- Namn, e-post, roll, datum de gick med

**Åtgärder:**
- Navigera mellan flikar
- Redigera interna anteckningar

---

### 23. Operator – Feedbacklista

Lista med all inkommande feedback från kunder.

**Innehåll:**
- Filterknappar: typ (alla, funktionsönskemål, buggrapport, support) och status (alla, öppen, pågår, klar, ej åtgärd)
- Tabell: typ, titel, företag, användare, status, prioritet, datum

**Åtgärder:**
- Filtrera på typ och/eller status
- Klicka på feedback för att se detaljer

---

### 24. Operator – Feedbackdetalj

Detaljsida för ett enskilt feedbackärende.

**Innehåll:**
- Typ (bugg, funktionsönskemål, support)
- Titel och beskrivning
- Inskickad av (namn, e-post)
- Företag
- Datum och tid
- Status och prioritet (redigerbara)
- Interna anteckningar med tidsstämplar

**Åtgärder:**
- Ändra status: öppen / pågår / klar / ej åtgärd
- Ändra prioritet: låg / medel / hög
- Lägg till intern anteckning
- Tillbaka till feedbacklistan

---

## Mail

Alla transaktionsmail skickas via Resend och delar samma visuella grundmall (ALLOCATE-ordmärke, vitt kort, mörk CTA-knapp, kopiera-och-klistra-fallbacklänk, grå fotnot). Alla auth-länkar pekar på Allocates egen domän (`allocate.at/auth/action`), aldrig på en Firebase-domän.

### 25. Teamsinbjudan

Mail som skickas när en admin bjuder in en ny användare till sitt företag.

**Ämnesrad:**
`[Avsändarens namn] har bjudit in dig till [Företagsnamn] på Allocate`

**Innehåll:**
- Avsändarens namn och vilket företag inbjudan gäller
- Rollen som användaren bjuds in som (Admin, Crew eller Viewer)
- CTA-knapp: "Acceptera inbjudan"
- Fallback-länk om knappen inte fungerar
- Notering: "Om du inte förväntade dig detta kan du ignorera detta mail"

**Data som behövs:**
- Företagsnamn
- Avsändarens namn
- Roll (Admin / Crew / Viewer)
- Länk till inbjudningssidan

---

### 26. Verifiera e-post

Mail som skickas för att bekräfta e-postadressen när ett konto skapas (och vid "Skicka om" från verifieringsvyn).

**Ämnesrad:**
`Confirm your email address`

**Innehåll:**
- Uppmaning att bekräfta e-postadressen för att slutföra kontot
- CTA-knapp: "Confirm email"
- Fallback-länk
- Fotnot: "If you didn’t create an Allocate account, you can safely ignore this email."

**Data som behövs:**
- Verifieringslänk (`allocate.at/auth/action?mode=verifyEmail`)

---

### 27. Återställ lösenord

Mail som skickas när en användare begär lösenordsåterställning (från "Glömt lösenord" eller "Byt lösenord" i kontoinställningar).

**Ämnesrad:**
`Reset your Allocate password`

**Innehåll:**
- Information om att en återställning har begärts
- CTA-knapp: "Reset password"
- Fallback-länk
- Fotnot: "If you didn’t request this, you can safely ignore this email — your password won’t change."

**Data som behövs:**
- Återställningslänk (`allocate.at/auth/action?mode=resetPassword`)

---

### 28. Bekräfta ny e-postadress

Mail som skickas till den **nya** adressen när en användare byter inloggnings-e-post i kontoinställningar.

**Ämnesrad:**
`Confirm your new email address`

**Innehåll:**
- Bekräftar vilken ny adress bytet gäller
- CTA-knapp: "Confirm change"
- Fallback-länk
- Fotnot: "If you didn’t request this, you can safely ignore this email — nothing will change."

**Data som behövs:**
- Den nya e-postadressen (visas i mailet)
- Bekräftelselänk (`allocate.at/auth/action?mode=verifyAndChangeEmail`)

---

*Totalt: 24 vyer + 4 mailmallar.*
