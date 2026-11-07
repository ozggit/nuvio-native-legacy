#include "pcpair.h"
#ifdef NV_WEBOS
#include "rede.h"
#include "js.h"
#include <pthread.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>
#include <time.h>
#include <sys/socket.h>
#include <sys/time.h>
#include <arpa/inet.h>

static pthread_mutex_t mutex = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t wake = PTHREAD_COND_INITIALIZER;
static unsigned long generation;
static int started, pending, ready;
static char wanted[5], result[192], failure[192];

static int cancelled(void *p) {
  unsigned long g = *(unsigned long *)p;
  pthread_mutex_lock(&mutex); int yes = generation != g; pthread_mutex_unlock(&mutex);
  return yes;
}
static int privateIp(uint32_t ip) {
  unsigned a = ip >> 24, b = (ip >> 16) & 255;
  return a == 10 || (a == 192 && b == 168) || (a == 172 && b >= 16 && b <= 31);
}
static void discover(unsigned long g, const char *code, char *pair, char *error) {
  int fd = socket(AF_INET, SOCK_DGRAM, 0);
  if (fd < 0) { snprintf(error,192,"Could not start PC discovery."); return; }
  int reuse = 1;
  struct timeval interval = { .tv_sec = 0, .tv_usec = 200000 };
  setsockopt(fd,SOL_SOCKET,SO_REUSEADDR,&reuse,sizeof reuse);
  if (setsockopt(fd,SOL_SOCKET,SO_RCVTIMEO,&interval,sizeof interval)) {
    snprintf(error,192,"Could not start PC discovery."); close(fd); return;
  }
  struct sockaddr_in listenAt = { .sin_family=AF_INET, .sin_port=htons(8789), .sin_addr={.s_addr=htonl(INADDR_ANY)} };
  if (bind(fd,(struct sockaddr *)&listenAt,sizeof listenAt)) {
    snprintf(error,192,"PC discovery is unavailable on this TV."); close(fd); return;
  }
  struct timespec begin, now; clock_gettime(CLOCK_MONOTONIC,&begin);
  while (!cancelled(&g)) {
    clock_gettime(CLOCK_MONOTONIC,&now);
    if (now.tv_sec-begin.tv_sec >= 30) break;
    char packet[160], ticket[33] = "", host[INET_ADDRSTRLEN]; unsigned port; int end=0;
    struct sockaddr_in peer; socklen_t peerSize=sizeof peer;
    ssize_t length=recvfrom(fd,packet,sizeof packet-1,0,(struct sockaddr *)&peer,&peerSize);
    if (length <= 0 || !privateIp(ntohl(peer.sin_addr.s_addr))) continue;
    packet[length]=0;
    if (sscanf(packet,"NUVIO-PC-PAIR/1 %u %32[0123456789abcdef]%n",&port,ticket,&end)!=2 ||
        !port || port>65535 || strlen(ticket)!=32 || end!=length) continue;
    if (!inet_ntop(AF_INET,&peer.sin_addr,host,sizeof host)) continue;
    char url[128], body[100];
    snprintf(url,sizeof url,"http://%s:%u/v1/pair",host,port);
    snprintf(body,sizeof body,"{\"code\":\"%s\",\"ticket\":\"%s\"}",code,ticket);
    const char *headers[] = { "Content-Type: application/json", NULL };
    RedePedido request = { .metodo="POST", .url=url, .cabecalhos=headers,
      .corpo=body, .n_corpo=strlen(body), .prazo_ms=5000, .max_bytes=1024,
      .parar=cancelled, .parar_usuario=&g };
    RedeResposta response={0}; rede_pedir(&request,&response);
    if (!cancelled(&g)) {
      char token[64]="";
      if (response.erro==REDE_OK && response.status==200 && response.corpo &&
          js_num(response.corpo,NULL,"protocol",0)==1 &&
          js_texto_raiz(response.corpo,"token",token,sizeof token) && strlen(token)==48 &&
          strspn(token,"0123456789abcdef")==48) {
        snprintf(pair,192,"http://%s:%u#%s",host,port,token);
      } else if (response.status==401) snprintf(error,192,"Code did not match. Check the four digits on the PC.");
      else if (response.status==429) snprintf(error,192,"Too many attempts. Generate a new code on the PC.");
      else if (response.status==410) snprintf(error,192,"Code expired or was used. Generate a new code on the PC.");
      else snprintf(error,192,"Could not pair with the PC. Generate a new code and retry.");
      memset(token,0,sizeof token);
    }
    rede_resposta_limpar(&response); break;
  }
  close(fd);
  if (!pair[0] && !error[0] && !cancelled(&g))
    snprintf(error,192,"PC not found. Show a new code on the PC and use the same local network.");
}
static void *worker(void *unused) {
  (void)unused; unsigned long handled=0;
  for (;;) {
    pthread_mutex_lock(&mutex);
    while (handled==generation) pthread_cond_wait(&wake,&mutex);
    unsigned long g=handled=generation; char code[5]; memcpy(code,wanted,sizeof code);
    pthread_mutex_unlock(&mutex);
    if (!code[0]) continue;
    char pair[192]="", error[192]="";
    discover(g,code,pair,error); memset(code,0,sizeof code);
    pthread_mutex_lock(&mutex);
    if (g==generation) { memcpy(result,pair,sizeof result); memcpy(failure,error,sizeof failure); pending=0; ready=1; }
    pthread_mutex_unlock(&mutex); memset(pair,0,sizeof pair);
  }
  return NULL;
}
int pcpair_iniciar(const char *code) {
  if (!code || strlen(code)!=4 || strspn(code,"0123456789")!=4) return 0;
  pthread_mutex_lock(&mutex);
  if (!started) {
    pthread_t thread;
    if (pthread_create(&thread,NULL,worker,NULL)) { pthread_mutex_unlock(&mutex); return 0; }
    pthread_detach(thread); started=1;
  }
  ++generation; memcpy(wanted,code,sizeof wanted); pending=1; ready=0;
  memset(result,0,sizeof result); failure[0]=0;
  pthread_cond_signal(&wake); pthread_mutex_unlock(&mutex); return 1;
}
void pcpair_cancelar(void) {
  pthread_mutex_lock(&mutex); ++generation; memset(wanted,0,sizeof wanted); memset(result,0,sizeof result);
  pending=ready=0; pthread_cond_signal(&wake); pthread_mutex_unlock(&mutex);
}
int pcpair_pendente(void) { pthread_mutex_lock(&mutex); int yes=pending; pthread_mutex_unlock(&mutex); return yes; }
int pcpair_receber(char *pair,size_t cap,char *error,size_t errorCap) {
  pthread_mutex_lock(&mutex); int yes=ready;
  if (yes) { snprintf(pair,cap,"%s",result); snprintf(error,errorCap,"%s",failure); ready=0; memset(result,0,sizeof result); }
  pthread_mutex_unlock(&mutex); return yes;
}
#else
int pcpair_iniciar(const char *c) { (void)c; return 0; }
void pcpair_cancelar(void) {}
int pcpair_pendente(void) { return 0; }
int pcpair_receber(char *p,size_t n,char *e,size_t m) { (void)p;(void)n;(void)e;(void)m;return 0; }
#endif
