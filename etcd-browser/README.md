# etcd browser

Przeglądarka danych i konsola administracyjna klastrów etcd dla Windows, macOS i Linuksa.
Jeden plik wykonywalny, bez instalacji i bez zależności. Działa z etcd 3.4 i nowszym (API v3),
testowane z etcd 3.6.12.

## Uruchomienie

**Windows** – rozpakuj `etcd-browser-…-windows-amd64.zip` (lub `arm64` dla komputerów ARM)
i uruchom `etcd-browser.exe`. Plik nie jest podpisany cyfrowo, więc SmartScreen może pokazać
ostrzeżenie: *Więcej informacji → Uruchom mimo to*.

**macOS** (Intel i Apple Silicon) – rozpakuj `etcd-browser-…-macos-universal.zip`
i przeciągnij `etcd browser.app` do folderu Aplikacje. Aplikacja nie jest notaryzowana przez
Apple, dlatego przy pierwszym uruchomieniu macOS ją zablokuje. Otwórz *Ustawienia systemowe →
Prywatność i ochrona* i kliknij *Otwórz mimo to* albo zdejmij flagę kwarantanny w Terminalu:

```
xattr -dr com.apple.quarantine "/Applications/etcd browser.app"
```

**Linux** – rozpakuj `etcd-browser-…-linux-amd64.tar.gz` (lub `arm64`) i uruchom `./etcd-browser`.
Aby dodać skrót do menu: skopiuj `etcd-browser` do `~/.local/bin`, `etcd-browser.png`
do `~/.local/share/icons`, a `etcd-browser.desktop` do `~/.local/share/applications`.

Interfejs otwiera się we własnym oknie przeglądarki opartej na Chromium (Edge, Chrome, Chromium,
Brave, Vivaldi). Gdy żadnej nie ma, otwiera się zwykła karta w domyślnej przeglądarce.
Zamknięcie okna kończy program.

## Połączenie z jednym węzłem, zarządzanie całym klastrem

Wystarczy podać adres jednego węzła. Aplikacja pobiera listę członków klastra i łączy się
z każdym z nich bezpośrednio tam, gdzie wymaga tego etcd (status, defragmentacja, snapshot,
suma kontrolna, przekazanie przywództwa).

Jeśli członkowie rozgłaszają adresy niedostępne z Twojego komputera (sieć wewnętrzna,
Kubernetes, Docker), zobaczysz ich jako nieosiągalnych. Przycisk **Adres…** w widoku
*Klaster* pozwala wskazać adres, pod którym dany członek jest widoczny (np. przekierowany port).
Adres zapisuje się w profilu połączenia.

## Funkcje

- **Klucze** – drzewo z grupowaniem po separatorze (`/`, `:`, `.` lub lista płaska), liczba kluczy
  w każdym katalogu, wyszukiwanie w kluczach i wartościach (tekst lub regex), podgląd jako tekst,
  sformatowany JSON, hex lub Base64, edycja z kontrolą współbieżności (zapis nie nadpisze
  cudzej zmiany bez pytania), dzierżawy kluczy, historia wersji z porównaniem i przywracaniem,
  kopiowanie klucza, usuwanie klucza lub całego prefiksu, eksport i import JSON (także z wyniku
  `etcdctl get --prefix -w json`) z możliwością zmiany prefiksu.
- **Klaster** – członkowie, lider, learnerzy, wersje, rozmiar bazy względem limitu, raft term
  i indeks, opóźnienie; dodawanie członka (także jako learner, z gotową konfiguracją do
  uruchomienia), promowanie learnera, przekazanie przywództwa, zmiana adresów peer, usuwanie.
- **Konserwacja** – kompakcja (zachowaj ostatnie N rewizji, do bieżącej lub do wskazanej),
  defragmentacja pojedynczego członka albo wszystkich po kolei (lider na końcu), kreator
  *Odzyskaj miejsce* (kompakcja → defragmentacja → rozbrojenie alarmu NOSPACE), alarmy,
  sprawdzanie spójności danych (HashKV) i pobieranie snapshotu z wybranego członka.
- **Dzierżawy** – lista z pozostałym czasem i przypisanymi kluczami, tworzenie, odnawianie,
  unieważnianie.
- **Dostęp** – włączanie i wyłączanie uwierzytelniania, użytkownicy, role i uprawnienia
  do kluczy, prefiksów i zakresów.
- **Obserwacja** – zmiany kluczy na żywo (watch), także od wskazanej rewizji z przeszłości.

Pasek górny pokazuje stan kworum (kropka na każdego członka, lider w złotej obwódce) oraz
linijkę rewizji: zakreskowana część to historia usunięta kompakcją, pełna – historia wciąż
przechowywana w bazie. Rosnąca pełna część oznacza, że nikt nie kompaktuje klastra.

### Bezpieczeństwo pracy

- Profil **tylko do odczytu** blokuje wszystkie zmiany – także po stronie serwera aplikacji.
- Profil oznaczony jako **produkcyjny** ma czerwony pasek, a operacje niszczące wymagają
  wpisania nazwy profilu.
- Usunięcie prefiksu wymaga wpisania liczby usuwanych kluczy.

## Połączenia i TLS

Profil połączenia obsługuje użytkownika i hasło, TLS z własnym CA, certyfikat klienta (mTLS),
nazwę serwera (SNI) i wyłączenie weryfikacji certyfikatu. Certyfikaty można wkleić w formacie
PEM, wczytać z pliku albo podać ścieżkę do pliku.

Profile są zapisywane w pliku `profiles.json` w katalogu konfiguracji użytkownika:

| System  | Katalog                                        |
|---------|------------------------------------------------|
| Windows | `%AppData%\etcd-browser`                       |
| macOS   | `~/Library/Application Support/etcd-browser`   |
| Linux   | `~/.config/etcd-browser`                       |

Hasło jest zapisywane tylko po zaznaczeniu *Zapamiętaj hasło* – jawnym tekstem w pliku
dostępnym wyłącznie dla Twojego konta. Bez tej opcji hasło trzeba podawać przy każdym połączeniu.

## Jak to działa

Program uruchamia lokalny serwer na `127.0.0.1` (port 23790 lub losowy, jeśli zajęty) i otwiera
w nim interfejs. Każde żądanie wymaga losowego klucza sesji generowanego przy starcie, a serwer
odrzuca żądania z innych stron i nazw hostów. Z etcd łączy się oficjalnym klientem Go
(`go.etcd.io/etcd/client/v3`) przez gRPC – ten sam protokół co `etcdctl`.

Parametry wiersza poleceń:

```
--serve              tryb serwera: bez okna, bez automatycznego zamykania (adres wypisze się w terminalu)
--listen ADRES       adres nasłuchu, np. 127.0.0.1:8080 (domyślnie 127.0.0.1:23790)
--no-window          nie otwieraj okna, tylko wypisz adres
--config-dir KATALOG inny katalog konfiguracji
--debug              szczegółowe logi na standardowym wyjściu
--version            wersja programu
```

Log działania programu znajduje się w pliku `etcd-browser.log` w katalogu konfiguracji.

## Budowanie ze źródeł

Wymagany Go 1.25 lub nowszy.

```
go build -o etcd-browser .     # bieżący system
./build.sh                     # paczki dla Windows, macOS i Linuksa w katalogu dist/
```

## Licencje

Kod aplikacji można dowolnie wykorzystywać. Wykorzystuje klienta etcd (Apache 2.0) oraz krój
pisma IBM Plex (SIL Open Font License 1.1, `web/fonts/OFL-IBM-Plex.txt`).
